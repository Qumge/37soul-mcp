/** Assets-only scheduler. Legacy transcript queues/spool remain local and untouched. */

import { formatExtractionDiagnostic } from "../extraction/diagnostics.js";
import path from "node:path";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { type readIncrement } from "./reader.js";
import { type GitStateResult } from "./git-state.js";
import { type UploadQueue } from "./queue.js";
import { type BriefFetchResult, type BriefTarget } from "./brief-cache.js";
import { loadState, saveState, type DaemonState } from "./state.js";

// Task 4: bounded extraction jobs run in the daemon process. The side-effect
// import registers the runtime_event / commit_extraction writer commands in the
// writer process this daemon hosts; the daemon tick fires the extraction drain
// fire-and-forget (bounded by the 2-attempt budget) so a pending watermark written
// by the hook becomes an asset, without ever blocking the capture loop on a model.
import "../extraction/scheduler.js";
import { drainPendingExtractions } from "../extraction/scheduler.js";
import "../sync/client.js"; // side effect: register sync_once / record_receipt / review_asset / delete_asset
import { isAssetsModeSync, type SyncReport } from "../sync/client.js";
import { runSyncProfiles } from "../sync/run.js";
import type { RuntimeAdapter } from "../adapters/types.js";
export { drainPendingExtractions } from "../extraction/scheduler.js";

/** Assets-mode cloud sync cadence when `config.syncIntervalMs` is not set. */
export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;

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
  /** Retired input: ignored; never authorizes transcript upload. */
  tokens: Record<string, string>;
  home: string;
  /** Retired input: ignored; native source indexing remains local. */
  transcriptFallback?: string[];
  pollIntervalMs?: number;
  idleFlushMs?: number;
  batchLimit?: number;
  sessionEndMs?: number;
  briefRefreshMs?: number;
  /** Assets-mode cloud sync cadence (defaults to DEFAULT_SYNC_INTERVAL_MS). */
  syncIntervalMs?: number;
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
  /** Runtime adapters (Task 6+) keyed by runtime_kind; present ones drive the extraction drain. */
  extractAdapters?: Partial<Record<string, RuntimeAdapter>>;
  /** Assets-mode cloud sync (defaults to runSyncProfiles); injected by tests. */
  syncProfiles?: (root: string) => Promise<Array<{ profile_id: string; report: SyncReport }>>;
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
  drainExtractions(): Promise<{ started: number; completed: number; failed: number }>;
  stop(): Promise<void>;
}

export function createDaemon(config: DaemonConfig, deps: DaemonDeps = {}): Daemon {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? { info: () => {}, error: () => {} };
  const save = deps.saveState ?? saveState;
  const extractAdapters = deps.extractAdapters ?? {};
  const syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const syncProfiles = deps.syncProfiles ?? runSyncProfiles;

  const blockedAgents = new Set<string>();
  let state: DaemonState | null = null;
  let releaseLock: (() => Promise<void>) | null = null;

  function daemonState(): DaemonState {
    if (!state) throw new Error("daemon not started (call tick() or start())");
    return state;
  }

  async function ensureStarted(): Promise<void> {
    if (state) return;
    state = await loadState(config.root);
    releaseLock = await (deps.acquireLock ?? acquireLock)(config.root);
  }

  // Retained entry points are inert: do not discover, replay, mutate or trim raw data.
  async function scan(): Promise<void> { await ensureStarted(); }
  async function processQueue(): Promise<void> { await ensureStarted(); }

  async function tick(): Promise<void> {
    await ensureStarted();
    scheduleDrain();
    scheduleSync();
  }

  type DrainStats = { started: number; completed: number; failed: number };
  let drainInFlight: Promise<DrainStats> | null = null;

  let lastSyncAt = 0;
  let syncInFlight: Promise<unknown> | null = null;

  async function runDrain(): Promise<DrainStats> {
    if (Object.keys(extractAdapters).length === 0) return { started: 0, completed: 0, failed: 0 };
    return drainPendingExtractions(config.root, extractAdapters, {diagnostic: counts => log.info(formatExtractionDiagnostic(counts))});
  }

  /** Fire-and-forget the extraction drain: never blocks the capture loop on a model call. */
  function scheduleDrain(): void {
    if (drainInFlight) return;
    drainInFlight = runDrain()
      .then((stats) => {
        if (stats.started > 0) {
          log.info(`extraction drain: started ${stats.started}, completed ${stats.completed}, failed ${stats.failed}`);
        }
        return stats;
      })
      .catch((error: unknown) => {
        log.error(`extraction drain failed: ${error instanceof Error ? error.message : String(error)}`);
        return { started: 0, completed: 0, failed: 0 };
      })
      .finally(() => {
        drainInFlight = null;
      });
  }

  /** The same bounded drain the tick fires; awaited directly by callers/tests. */
  async function drainExtractions(): Promise<DrainStats> {
    scheduleDrain();
    return drainInFlight ?? { started: 0, completed: 0, failed: 0 };
  }

  type SyncStats = { profiles: number; accepted: number; conflicts: number; pending: number };

  async function runSyncOnce(): Promise<SyncStats> {
    const reports = await syncProfiles(config.root);
    const stats = reports.reduce<SyncStats>(
      (acc, { report }) => ({
        profiles: acc.profiles + 1,
        accepted: acc.accepted + report.accepted,
        conflicts: acc.conflicts + report.conflicts,
        pending: acc.pending + report.pending,
      }),
      { profiles: 0, accepted: 0, conflicts: 0, pending: 0 },
    );
    log.info(
      `sync: ${stats.profiles} profile(s), ${stats.accepted} accepted, ${stats.conflicts} conflict(s), ${stats.pending} pending`,
    );
    return stats;
  }

  /**
   * Fire-and-forget the assets-mode cloud sync, gated on the sync interval and on
   * assets mode. A rejection never kills the tick loop; `lastSyncAt` advances only
   * when the run settles (success or failure) so a failure retries next interval,
   * not next tick.
   */
  function scheduleSync(): void {
    if (syncInFlight) return;
    if (now() - lastSyncAt < syncIntervalMs) return;
    if (!isAssetsModeSync(config.root)) return;
    syncInFlight = runSyncOnce()
      .catch((error: unknown) => {
        log.error(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        lastSyncAt = now();
        syncInFlight = null;
      });
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
    drainExtractions,
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

/** Raw transcript/spool discovery is retired, regardless of supplied credentials. */
export function defaultDiscover(_config: DaemonConfig): () => Promise<SessionSource[]> {
  return async () => [];
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
