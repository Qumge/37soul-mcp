/**
 * agentd 的调度核心（设计 §6.2）。
 *
 * 一轮 tick 做三件事：
 *   1. scan()：把所有会话文件按 cursor 增量读进内存缓冲；
 *      触发上传的条件 —— 空闲 60 秒 / 累计 100 个事件 / 空闲 5 分钟（发 session_end）；
 *   2. processQueue()：按「每会话 seq 升序」重放待上传批次，处理 413/409/401/退避；
 *   3. 到点的简报刷新 + 状态落盘。
 *
 * 时钟、fs、http、git 全部可注入：测试用假时钟 + 假 fetch 驱动 tick()，不 sleep。
 * 「事件先进队列，再推进 cursor」这条顺序是本模块的核心不变量。
 */

import path from "node:path";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { createClaudeCodeParser } from "./parsers/claude-code.js";
import { createCodexParser } from "./parsers/codex.js";
import { createSpoolParser, spoolFiles, trimSpool } from "./spool.js";
import { readIncrement, type ReadIncrementResult } from "./reader.js";
import { getGitState, type GitStateResult } from "./git-state.js";
import { UploadQueue, uploadId, type QueuedUpload } from "./queue.js";
import { buildUploadBody, uploadBatch, type UploaderDeps } from "./uploader.js";
import { refreshBrief, type BriefFetchResult, type BriefTarget } from "./brief-cache.js";
import { loadState, saveState, type DaemonState } from "./state.js";
import { batchEvents, validateBatch, ProtocolError } from "./protocol.js";
import { repoKey } from "../repo-key.js";
import type { FileCursor, NormalizedEvent, SessionMetadata, TranscriptParser } from "./types.js";

// Task 4: bounded extraction jobs run in the daemon process. The side-effect
// import registers the runtime_event / commit_extraction writer commands in the
// writer process this daemon hosts; drainPendingExtractions is re-exported so the
// agentd entry point can run pending/under-budget jobs (next checkpoint / explicit
// retry), never an immediate loop.
import "../extraction/scheduler.js";
export { drainPendingExtractions } from "../extraction/scheduler.js";

export interface SessionSource {
  agentKind: string;
  file: string;
  externalId?: string;
  /** spool = hook 写入（主路径）；transcript = 会话记录兜底解析。 */
  parser?: "spool" | "transcript";
}

export interface DaemonConfig {
  root: string;
  apiBaseUrl: string;
  machineId: string;
  /** agent_kind → bearer token；缺一个就停那个 Agent。 */
  tokens: Record<string, string>;
  home: string;
  /** v2 §6.2：默认关闭的会话记录兜底；列在这里的 Agent 才扫记录目录。 */
  transcriptFallback?: string[];
  pollIntervalMs?: number;
  idleFlushMs?: number;
  batchLimit?: number;
  sessionEndMs?: number;
  briefRefreshMs?: number;
}

export interface DaemonDeps {
  now?: () => number;
  fetch?: typeof fetch;
  log?: { info: (m: string) => void; error: (m: string) => void };
  discover?: () => Promise<SessionSource[]>;
  getGitState?: (cwd: string) => Promise<GitStateResult>;
  readIncrement?: typeof readIncrement;
  queue?: UploadQueue;
  refreshBrief?: (target: BriefTarget) => Promise<BriefFetchResult>;
  acquireLock?: (root: string) => Promise<() => Promise<void>>;
  saveState?: (root: string, state: DaemonState) => Promise<void>;
}

interface SessionRuntime {
  key: string;
  source: SessionSource;
  parser: TranscriptParser;
  cursor: FileCursor | null;
  events: NormalizedEvent[];
  lastEventAt: number;
  sessionEndSent: boolean;
  metadata: SessionMetadata;
}

export interface Daemon {
  scan(): Promise<void>;
  processQueue(): Promise<void>;
  tick(): Promise<void>;
  pauseAll(paused: boolean): Promise<void>;
  pauseRepo(repoKeyValue: string, paused: boolean): Promise<void>;
  resumeAll(): Promise<void>;
  blockedAgents(): string[];
  state(): DaemonState;
  stop(): Promise<void>;
}

export function createDaemon(config: DaemonConfig, deps: DaemonDeps = {}): Daemon {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? { info: () => {}, error: () => {} };
  const discover = deps.discover ?? defaultDiscover(config);
  const gitState = deps.getGitState ?? ((cwd: string) => getGitState(cwd));
  const readFn = deps.readIncrement ?? readIncrement;
  const queue = deps.queue ?? new UploadQueue({ root: config.root, now, log });
  const save = deps.saveState ?? saveState;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const refresh = deps.refreshBrief ?? ((target: BriefTarget) => refreshBrief({
    root: config.root,
    fetch: fetchImpl,
    baseUrl: config.apiBaseUrl,
    tokenFor: (kind) => config.tokens[kind] ?? null,
    machineId: config.machineId,
    log,
  }, target));

  const idleFlushMs = config.idleFlushMs ?? 60_000;
  const batchLimit = config.batchLimit ?? 100;
  const sessionEndMs = config.sessionEndMs ?? 5 * 60_000;
  const briefRefreshMs = config.briefRefreshMs ?? 3 * 60_000;

  const sessions = new Map<string, SessionRuntime>();
  const blockedAgents = new Set<string>();
  const pendingRefreshes = new Map<string, { target: BriefTarget; due: number[] }>();
  let state: DaemonState | null = null;
  let releaseLock: (() => Promise<void>) | null = null;

  const uploaderDeps: UploaderDeps = {
    fetch: fetchImpl,
    baseUrl: config.apiBaseUrl,
    tokenFor: (kind) => config.tokens[kind] ?? null,
    log,
  };

  function daemonState(): DaemonState {
    if (!state) throw new Error("daemon not started (call tick() or start())");
    return state;
  }

  async function ensureStarted(): Promise<void> {
    if (state) return;
    state = await loadState(config.root);
    releaseLock = await (deps.acquireLock ?? acquireLock)(config.root);
  }

  function runtimeFor(source: SessionSource): SessionRuntime {
    const key = `${source.agentKind}:${source.file}`;
    const existing = sessions.get(key);
    if (existing) return existing;

    const parser = source.parser === "spool"
      ? createSpoolParser({ externalId: source.externalId })
      : source.agentKind === "codex"
        ? createCodexParser({ externalId: source.externalId })
        : createClaudeCodeParser({ externalId: source.externalId });
    const runtime: SessionRuntime = {
      key,
      source,
      parser,
      cursor: null,
      events: [],
      lastEventAt: now(),
      sessionEndSent: false,
      metadata: { external_id: source.externalId ?? "" },
    };
    sessions.set(key, runtime);
    return runtime;
  }

  async function scan(): Promise<void> {
    await ensureStarted();
    if (daemonState().paused) return;

    const sources = await discover();
    const seen = new Set<string>();
    for (const source of sources) {
      const runtime = runtimeFor(source);
      seen.add(runtime.key);
      const stored = daemonState().sessions[runtime.key]?.cursor;
      const cursor = runtime.cursor ?? stored ?? null;

      let result: ReadIncrementResult;
      try {
        result = await readFn(source.file, cursor, { parser: runtime.parser });
      } catch {
        continue; // 文件在扫描中途消失/不可读：下一轮再说
      }

      if (result.restarted) log.info(`${runtime.key}: file rolled over (truncated or replaced); reading from the start with continuing seq`);
      for (const diagnostic of result.diagnostics) log.error(`${runtime.key}: ${diagnostic}`);

      if (result.events.length > 0) {
        runtime.events.push(...result.events);
        runtime.lastEventAt = now();
        runtime.sessionEndSent = false;
      }
      runtime.metadata = { ...runtime.metadata, ...result.metadata };
      runtime.cursor = result.nextCursor;
      // v2 §6.2：收到 session_end / compact 立即上传，不等空闲窗口。
      const immediate = result.events.some((event) => event.kind === "session_end" || event.kind === "compact");
      await maybeFlush(runtime, { immediate });
    }

    // 文件这轮没出现（Agent 关了）：缓冲还留着，按空闲规则收尾。
    for (const runtime of sessions.values()) {
      if (!seen.has(runtime.key)) await maybeFlush(runtime);
    }
  }

  async function maybeFlush(runtime: SessionRuntime, opts: { immediate?: boolean } = {}): Promise<void> {
    const idle = now() - runtime.lastEventAt;
    const wantsSessionEnd = idle >= sessionEndMs && !runtime.sessionEndSent && runtime.cursor !== null;
    if (
      (opts.immediate && runtime.events.length > 0) ||
      runtime.events.length >= batchLimit ||
      (runtime.events.length > 0 && idle >= idleFlushMs) ||
      wantsSessionEnd
    ) {
      await flush(runtime, wantsSessionEnd);
    }
  }

  async function flush(runtime: SessionRuntime, withSessionEnd: boolean): Promise<void> {
    if (withSessionEnd) {
      const seq = (runtime.cursor?.seq ?? 0) + 1;
      runtime.events.push({ seq, at: new Date(now()).toISOString(), event_type: "session_end" });
      runtime.cursor = { ...(runtime.cursor ?? { inode: 0, offset: 0, seq: 0 }), seq };
      runtime.sessionEndSent = true;
    }
    if (runtime.events.length === 0 || runtime.cursor === null) return;

    const events = runtime.events.slice();

    try {
      validateBatch(events);
    } catch (error) {
      if (error instanceof ProtocolError) {
        log.error(`${runtime.key}: dropping ${events.length} invalid events (${error.message})`);
        runtime.events = [];
        persistCursor(runtime);
        await save(config.root, daemonState());
        return;
      }
      throw error;
    }

    const cwd = runtime.metadata.cwd ?? null;
    let git: GitStateResult | null = null;
    if (cwd) {
      try {
        git = await gitState(cwd);
      } catch {
        git = null;
      }
    }
    const remote = git?.repo.remote ?? null;
    const branch = runtime.metadata.branch ?? git?.repo.branch ?? null;
    const key = repoKey({ remote, machineId: config.machineId, cwd });

    if (key && daemonState().paused_repos?.includes(key)) {
      log.info(`${runtime.key}: repo ${key} is paused; keeping ${events.length} events local`);
      return; // cursor 不推进，事件留在缓冲里
    }

    const createdAt = now();
    const containsMarkers = events.some(
      (event) => event.kind === "session_end" || event.kind === "compact" || event.event_type === "session_end",
    );
    const makeItem = (batch: NormalizedEvent[], seqFrom: number, seqTo: number): QueuedUpload => ({
      id: uploadId(runtime.key, seqFrom, seqTo),
      sessionKey: runtime.key,
      agentKind: runtime.source.agentKind,
      machineId: config.machineId,
      externalId: runtime.metadata.external_id,
      session: {
        external_id: runtime.metadata.external_id,
        ...(runtime.metadata.cwd ? { cwd: runtime.metadata.cwd } : {}),
        ...(runtime.metadata.started_at ? { started_at: runtime.metadata.started_at } : {}),
      },
      repo: key ? { remote: remote ?? undefined, branch: branch ?? undefined } : undefined,
      seqFrom,
      seqTo,
      events: batch,
      gitState: git?.git_state ?? null,
      containsMarkers,
      createdAt,
      attempts: 0,
      nextAttemptAt: createdAt,
    });

    const batches = batchEvents(events, (batch, seqFrom, seqTo) => buildUploadBody(makeItem(batch, seqFrom, seqTo)));

    // ⚠️ 顺序：先入队（durable），再推进 offset。反过来的话，崩溃会丢事件。
    for (const batch of batches) await queue.enqueue(makeItem(batch.events, batch.seqFrom, batch.seqTo));

    runtime.events = [];
    persistCursor(runtime);
    await save(config.root, daemonState());

    if (key) {
      scheduleBriefRefresh({ agentKind: runtime.source.agentKind, repoKey: key, remote, branch, cwd });
    }
    log.info(`${runtime.key}: queued ${batches.length} batch(es), ${events.length} events`);
  }

  function persistCursor(runtime: SessionRuntime): void {
    if (runtime.cursor === null) return;
    const existing = daemonState().sessions[runtime.key] ?? {};
    daemonState().sessions[runtime.key] = { ...existing, cursor: runtime.cursor };
  }

  async function processQueue(pass = 0): Promise<void> {
    await ensureStarted();
    if (daemonState().paused) return;

    const items = await queue.list();
    const bySession = new Map<string, QueuedUpload[]>();
    for (const item of items) {
      const list = bySession.get(item.sessionKey) ?? [];
      list.push(item);
      bySession.set(item.sessionKey, list);
    }

    let mustRepeat = false;

    for (const [sessionKey, list] of bySession) {
      list.sort((a, b) => a.seqFrom - b.seqFrom);
      let forcedEarlier = false;

      for (const item of list) {
        if (blockedAgents.has(item.agentKind)) break;
        if (item.nextAttemptAt > now() && !forcedEarlier) continue;
        forcedEarlier = false;

        const outcome = await uploadBatch(uploaderDeps, item);
        switch (outcome.status) {
          case "accepted":
          case "duplicate": {
            await queue.remove(item.id);
            const existing = daemonState().sessions[sessionKey] ?? {};
            daemonState().sessions[sessionKey] = {
              ...existing,
              last_upload_at: new Date(now()).toISOString(),
              last_uploaded_seq: item.seqTo,
            };
            await save(config.root, daemonState());
            log.info(`${item.id}: ${outcome.status}`);

            // 审查修复 3：会话结束/压缩的批次一上传成功就刷新 brief.md（这就是
            // 「退出 Claude Code 立刻打开 Codex 说继续」能成立的原因），
            // 并在总结防抖（2 分钟）过后再刷一次把整理好的交接单落盘。
            if (item.containsMarkers && item.repo) {
              const key = repoKey({ remote: item.repo.remote, machineId: config.machineId, cwd: item.session.cwd });
              if (key) {
                const target: BriefTarget = {
                  agentKind: item.agentKind,
                  repoKey: key,
                  remote: item.repo.remote,
                  branch: item.repo.branch ?? null,
                  cwd: item.session.cwd ?? null,
                };
                scheduleBriefRefresh(target, 0);
                scheduleBriefRefresh(target, 150_000);
              }
            }
            break;
          }
          case "size_limit": {
            const parts = outcome.split ?? [];
            await queue.replace(item, parts);
            log.info(`${item.id}: 413 — split into ${parts.length} batch(es)`);
            break;
          }
          case "invalid":
            log.error(`${item.id}: unprocessable batch dropped (${outcome.error})`);
            await queue.remove(item.id);
            break;
          case "unauthorized":
            blockedAgents.add(item.agentKind);
            log.error(`${item.agentKind}: token rejected — capture stopped for this agent until it is reconnected`);
            break;
          case "gap": {
            const earlier = list.filter((candidate) => candidate.seqTo < item.seqFrom);
            if (earlier.length > 0) {
              // 服务端在等更早的批次：把它们提前到这一轮，按 seq 顺序补上。
              await queue.scheduleNow(earlier[0].id);
              mustRepeat = true;
              forcedEarlier = true;
              log.info(`${item.id}: server expects seq ${outcome.expectedSeq}; replaying earlier batches first`);
            } else {
              await queue.markAttempt(item.id, `gap: expected seq ${outcome.expectedSeq}`);
              log.error(
                `${item.id}: gap with no earlier batch in the local queue (server expects seq ${outcome.expectedSeq}); ` +
                  "these events cannot be accepted until the missing range is produced",
              );
            }
            break;
          }
          case "rate_limited":
          case "network":
            await queue.markAttempt(item.id, outcome.error ?? outcome.status);
            log.error(`${item.id}: upload failed (${outcome.status}); retry scheduled`);
            break;
        }
      }
    }

    if (mustRepeat && pass < 2) await processQueue(pass + 1);
  }

  // 审查修复 3：一个目标可以排多个刷新时刻 —— session_end/compact 上传成功后
  // 立刻刷一次（Codex 马上就能读到），总结跑完（约 2 分钟后）再刷一次，
  // 普通上传仍然是 3 分钟后一次。
  function scheduleBriefRefresh(target: BriefTarget, delayMs: number = briefRefreshMs): void {
    const key = `${target.repoKey}@${target.branch ?? "-"}`;
    const entry = pendingRefreshes.get(key) ?? { target, due: [] };
    entry.target = target; // 保留最新一次拿到的 branch/head
    const due = now() + delayMs;
    if (!entry.due.some((candidate) => Math.abs(candidate - due) < 1000)) entry.due.push(due);
    pendingRefreshes.set(key, entry);
  }

  async function refreshDueBriefs(): Promise<void> {
    for (const [key, entry] of [...pendingRefreshes.entries()]) {
      const dueNow = entry.due.filter((candidate) => candidate <= now());
      if (dueNow.length === 0) continue;
      entry.due = entry.due.filter((candidate) => candidate > now());
      if (entry.due.length === 0) pendingRefreshes.delete(key);
      try {
        const result = await refresh(entry.target);
        log.info(`brief refreshed for ${key}${result.fromCache ? " (from local cache)" : ""}`);
      } catch (error) {
        log.error(`brief refresh failed for ${key}: ${(error as Error).message}`);
      }
    }
  }

  async function tick(): Promise<void> {
    await ensureStarted();
    await scan();
    await processQueue();
    await refreshDueBriefs();
    // v2 §6.2：spool 总量超过 50MB 时丢最早的（诊断留给 caller 的 log）。
    await trimSpool(config.root, undefined, log).catch(() => {});
  }

  return {
    scan,
    processQueue,
    tick,
    async pauseAll(paused: boolean) {
      await ensureStarted();
      daemonState().paused = paused;
      await save(config.root, daemonState());
      log.info(paused ? "capture paused globally" : "capture resumed");
    },
    async pauseRepo(repoKeyValue: string, paused: boolean) {
      await ensureStarted();
      const list = new Set(daemonState().paused_repos ?? []);
      if (paused) list.add(repoKeyValue);
      else list.delete(repoKeyValue);
      daemonState().paused_repos = [...list];
      await save(config.root, daemonState());
      log.info(`repo ${repoKeyValue} ${paused ? "paused" : "resumed"}`);
    },
    async resumeAll() {
      await ensureStarted();
      daemonState().paused = false;
      daemonState().paused_repos = [];
      await save(config.root, daemonState());
    },
    blockedAgents: () => [...blockedAgents],
    state: daemonState,
    async stop() {
      if (state) await save(config.root, state);
      if (releaseLock) await releaseLock();
      releaseLock = null;
    },
  };
}

/** 单实例锁：同一台机器/同一个配置根只允许一个 agentd。 */
export async function acquireLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "agentd.lock");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      await handle.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await isStaleLock(file))) {
        throw new Error(`another agentd is already running (${file})`);
      }
      await rm(file, { force: true });
    }
  }
  throw new Error(`could not acquire the agentd lock at ${file}`);
}

async function isStaleLock(file: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { pid?: number };
    if (!parsed.pid) return true;
    process.kill(parsed.pid, 0);
    return false; // 活着
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return true;
  }
}

/** 默认的会话发现：spool（hook 主路径）+ 被显式开启的会话记录兜底。 */
export function defaultDiscover(config: DaemonConfig): () => Promise<SessionSource[]> {
  return async () => {
    const sources: SessionSource[] = [];

    // hook 写进 spool 的会话（主路径）。
    for (const agentKind of Object.keys(config.tokens)) {
      for (const file of await spoolFiles(config.root, agentKind)) {
        sources.push({
          agentKind,
          file,
          externalId: path.basename(file, ".jsonl"),
          parser: "spool",
        });
      }
    }

    // 会话记录兜底（v2 §6.2：默认关闭，config.transcript_fallback 里列出的才扫）。
    const fallback = new Set(config.transcriptFallback ?? []);
    if (fallback.size > 0) {
      for (const source of await discoverSessionSources(config.home)) {
        if (fallback.has(source.agentKind)) sources.push({ ...source, parser: "transcript" });
      }
    }

    return sources;
  };
}

/** 默认的会话文件发现：Claude Code 的 projects 下每个 jsonl，Codex 的 sessions 下递归的 rollout-*.jsonl。 */
export async function discoverSessionSources(home: string): Promise<SessionSource[]> {
  const sources: SessionSource[] = [];

  const claudeRoot = path.join(home, ".claude", "projects");
  for (const entry of await safeReaddir(claudeRoot)) {
    if (!entry.endsWith(".jsonl") || entry.includes("subagents")) continue;
    sources.push({
      agentKind: "claude-code",
      file: path.join(claudeRoot, entry),
      externalId: path.basename(entry, ".jsonl"),
    });
  }

  const codexRoot = path.join(home, ".codex", "sessions");
  for (const entry of await safeReaddir(codexRoot)) {
    if (!entry.endsWith(".jsonl") || !path.basename(entry).startsWith("rollout-")) continue;
    sources.push({
      agentKind: "codex",
      file: path.join(codexRoot, entry),
      externalId: path.basename(entry, ".jsonl"),
    });
  }

  return sources;
}

async function safeReaddir(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true })) as string[];
  } catch {
    return [];
  }
}
