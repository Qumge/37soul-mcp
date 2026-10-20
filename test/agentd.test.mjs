#!/usr/bin/env node
/**
 * agentd 调度：全部用注入的时钟 / fake fetch / 临时目录驱动 tick()，不 sleep。
 * 覆盖设计 §6.2 的攒批规则、重试/补洞、暂停、状态、日志与简报刷新。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemon, discoverSessionSources, acquireLock } from "../dist/agentd/daemon.js";
import { UploadQueue, uploadId } from "../dist/agentd/queue.js";
import { createRotatingLogger } from "../dist/agentd/logger.js";
import { appendSpoolRecord } from "../dist/agentd/spool.js";
import { loadState, saveState, emptyState } from "../dist/agentd/state.js";

const T0 = Date.parse("2026-10-17T05:00:00.000Z");

function tempDir(prefix = "agentd-test-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function userRecord(text, at) {
  return JSON.stringify({
    type: "user",
    timestamp: new Date(at).toISOString(),
    origin: { kind: "human" },
    message: { role: "user", content: text },
    sessionId: "session-fixture",
    cwd: "/tmp/nimbus",
    gitBranch: "feature/x",
  });
}

function writeSession(file, records, { append = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => `${r}\n`).join(""), { flag: append ? "a" : "w" });
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), headers: init.headers ?? {}, body });
    const reply = await handler({ url: String(url), headers: init.headers ?? {}, body }, calls.length);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      async json() {
        return reply.body ?? {};
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function queuedItem(overrides = {}) {
  const sessionKey = overrides.sessionKey ?? "claude-code:/tmp/session.jsonl";
  const seqFrom = overrides.seqFrom ?? 1;
  const seqTo = overrides.seqTo ?? 2;
  const events =
    overrides.events ??
    Array.from({ length: seqTo - seqFrom + 1 }, (_, i) => ({
      seq: seqFrom + i,
      at: new Date(T0).toISOString(),
      role: "user",
      text: `e${seqFrom + i}`,
    }));
  return {
    id: overrides.id ?? uploadId(sessionKey, seqFrom, seqTo),
    sessionKey,
    agentKind: "claude-code",
    machineId: "machine-1",
    externalId: "session-fixture",
    session: { external_id: "session-fixture" },
    seqFrom,
    seqTo,
    events,
    createdAt: T0,
    attempts: 0,
    nextAttemptAt: T0,
    ...overrides,
  };
}

/**
 * 一切可注入。harness() 返回一个可手摇的时钟 + 记录好的 fetch + 临时 root/home。
 */
function harness(overrides = {}) {
  const root = overrides.root ?? tempDir();
  const home = overrides.home ?? tempDir();
  const file = overrides.file ?? path.join(home, ".claude", "projects", "-tmp-nimbus", "session-fixture.jsonl");
  let clock = T0;
  const logs = [];
  const log = overrides.log ?? { info: (m) => logs.push(`INFO ${m}`), error: (m) => logs.push(`ERROR ${m}`) };
  const fetchImpl = overrides.fetch ?? fakeFetch(() => ({ status: 202, body: {} }));
  const queue = overrides.queue ?? new UploadQueue({ root, now: () => clock, log });

  const daemon = createDaemon(
    {
      root,
      apiBaseUrl: "https://api.test",
      machineId: "machine-1",
      tokens: overrides.tokens ?? { "claude-code": "SECRET-TOKEN-abc", codex: "SECRET-TOKEN-def" },
      home,
      ...(overrides.config ?? {}),
    },
    {
      now: () => clock,
      fetch: fetchImpl,
      log,
      discover: overrides.discover ?? (async () => [{ agentKind: "claude-code", file, externalId: "session-fixture" }]),
      getGitState:
        overrides.getGitState ??
        (async () => ({
          repo: { remote: "git@github.com:owner/nimbus.git", branch: "feature/x" },
          git_state: { branch: "feature/x", head: "abc123def456" },
        })),
      queue,
      refreshBrief: overrides.refreshBrief ?? (async () => ({ text: "brief", fromCache: false })),
      acquireLock: async () => async () => {},
      saveState,
      ...(overrides.deps ?? {}),
    },
  );

  return {
    root,
    home,
    file,
    logs,
    daemon,
    queue,
    fetch: fetchImpl,
    get clock() {
      return clock;
    },
    advance: (ms) => {
      clock += ms;
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("daemon: flushes after 60s idle and advances the durable cursor only after enqueueing", async () => {
  const h = harness();
  writeSession(h.file, [userRecord("第一句", T0), userRecord("第二句", T0 + 1000)]);

  await h.daemon.tick(); // 刚写完：不够空闲，也不满 100
  assert.equal(h.fetch.calls.length, 0);

  h.advance(61_000);
  await h.daemon.tick();

  assert.equal(h.fetch.calls.length, 1);
  const body = h.fetch.calls[0].body;
  assert.equal(body.seq_from, 1);
  assert.equal(body.seq_to, 2);
  assert.equal(body.events.length, 2);

  const state = await loadState(h.root);
  const stored = state.sessions["claude-code:" + h.file];
  assert.ok(stored.cursor.offset > 0);
  assert.equal(stored.last_uploaded_seq, 2);
  h.cleanup();
});

test("daemon: 100 events flush without waiting for idle and never exceed the batch cap", async () => {
  const h = harness({ config: { batchLimit: 100 } });
  writeSession(
    h.file,
    Array.from({ length: 100 }, (_, i) => userRecord(`消息 ${i}`, T0 + i)),
  );

  await h.daemon.tick();

  assert.equal(h.fetch.calls.length, 1);
  assert.equal(h.fetch.calls[0].body.events.length, 100);
  h.cleanup();
});

test("daemon: five minutes without writes sends one session_end marker; appends after it still flow", async () => {
  const h = harness();
  writeSession(h.file, [userRecord("收工前", T0)]);
  await h.daemon.tick(); // 先让它读到（空闲窗口从读到时起算）
  h.advance(61_000);
  await h.daemon.tick();
  assert.equal(h.fetch.calls.length, 1); // 60s 空闲先正常发一批

  h.advance(5 * 60_000);
  await h.daemon.tick();
  assert.equal(h.fetch.calls.length, 2);
  assert.deepEqual(h.fetch.calls[1].body.events.map((e) => e.event_type), ["session_end"]);

  writeSession(h.file, [userRecord("又回来了", T0 + 1_000_000)], { append: true });
  await h.daemon.tick(); // 先读到新增的那句
  h.advance(61_000);
  await h.daemon.tick();
  assert.equal(h.fetch.calls.length, 3);
  assert.deepEqual(h.fetch.calls[2].body.events.map((e) => [e.seq, e.text]), [[3, "又回来了"]]);
  h.cleanup();
});

test("daemon: watcher re-scans and polls never double-enqueue or double-upload", async () => {
  const h = harness();
  writeSession(h.file, [userRecord("一次", T0)]);
  await h.daemon.tick(); // 先读到
  h.advance(61_000);

  await h.daemon.tick();
  await h.daemon.scan(); // watcher 触发
  await h.daemon.tick(); // 30s 轮询触发

  assert.equal(h.fetch.calls.length, 1);
  h.cleanup();
});

test("daemon: 413 splits the batch and every event lands exactly once", async () => {
  const fetchImpl = fakeFetch((record) => (record.body.events.length > 2 ? { status: 413, body: { error: "too large" } } : { status: 202, body: {} }));
  const h = harness({ fetch: fetchImpl, config: { batchLimit: 4 } });
  writeSession(
    h.file,
    Array.from({ length: 4 }, (_, i) => userRecord(`事件 ${i}`, T0 + i)),
  );

  await h.daemon.tick(); // 满 4 条直接触发 -> 413 -> 拆成两半
  await h.daemon.tick(); // 两半各自上传

  assert.deepEqual(h.fetch.calls.map((call) => call.body.events.length), [4, 2, 2]);
  const acceptedSeqs = h.fetch.calls.slice(1).flatMap((call) => call.body.events.map((e) => e.seq));
  assert.deepEqual(acceptedSeqs.sort((a, b) => a - b), [1, 2, 3, 4]);
  h.cleanup();
});

test("daemon: replays a session strictly by seq order even when the queue was written out of order", async () => {
  const h = harness();
  await h.queue.enqueue(queuedItem({ seqFrom: 3, seqTo: 4, createdAt: T0 + 1 }));
  await h.queue.enqueue(queuedItem({ seqFrom: 1, seqTo: 2, createdAt: T0 }));

  await h.daemon.processQueue();

  assert.deepEqual(h.fetch.calls.map((call) => call.body.seq_from), [1, 3]);
  h.cleanup();
});

test("daemon: 409 expected_seq pulls the earlier failed batch forward instead of wedging", async () => {
  const h = harness();
  await h.queue.enqueue(queuedItem({ seqFrom: 1, seqTo: 2, nextAttemptAt: T0 + 60_000 }));
  await h.queue.enqueue(queuedItem({ seqFrom: 3, seqTo: 4 }));

  let seen = 0;
  h.fetch = fakeFetch((record) => {
    seen += 1;
    if (record.body.seq_from === 3 && seen === 1) return { status: 409, body: { error: "gap", expected_seq: 1 } };
    return { status: 202, body: {} };
  });
  const daemon = createDaemon(
    { root: h.root, apiBaseUrl: "https://api.test", machineId: "machine-1", tokens: { "claude-code": "t" }, home: h.home },
    {
      now: () => T0,
      fetch: h.fetch,
      log: { info: () => {}, error: () => {} },
      discover: async () => [],
      getGitState: async () => ({ repo: { remote: null, branch: null }, git_state: null }),
      queue: h.queue,
      acquireLock: async () => async () => {},
    },
  );

  await daemon.processQueue();

  assert.deepEqual(h.fetch.calls.map((call) => [call.body.seq_from, call.body.seq_to]), [
    [3, 4],
    [1, 2],
    [3, 4],
  ]);
  h.cleanup();
});

test("daemon: network failures back off, then the same batch uploads exactly once", async () => {
  let fail = true;
  const fetchImpl = fakeFetch(() => {
    if (fail) throw new Error("ECONNRESET");
    return { status: 202, body: {} };
  });
  const h = harness({ fetch: fetchImpl });
  writeSession(h.file, [userRecord("网络断了", T0)]);
  await h.daemon.tick(); // 先读到
  h.advance(61_000);

  await h.daemon.tick();
  assert.equal(h.fetch.calls.length, 1);

  await h.daemon.tick(); // 退避窗口里，不该重试
  assert.equal(h.fetch.calls.length, 1);

  fail = false;
  h.advance(120_000);
  await h.daemon.tick();

  assert.equal(h.fetch.calls.length, 2);
  assert.deepEqual(h.fetch.calls.at(-1).body.events.map((e) => e.seq), [1]);
  h.cleanup();
});

test("daemon: a rejected token stops that agent instead of hammering the API", async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401, body: { error: "unauthorized" } }));
  const h = harness({ fetch: fetchImpl });
  await h.queue.enqueue(queuedItem({ seqFrom: 1, seqTo: 1 }));
  await h.queue.enqueue(queuedItem({ seqFrom: 2, seqTo: 2 }));

  await h.daemon.processQueue();
  await h.daemon.processQueue();

  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(h.daemon.blockedAgents(), ["claude-code"]);
  h.cleanup();
});

test("daemon: pause stops capture globally and per repo, resume continues without losing events", async () => {
  const h = harness();
  writeSession(h.file, [userRecord("暂停前", T0)]);
  await h.daemon.tick(); // 先读到（还没到空闲阈值）
  h.advance(61_000);

  await h.daemon.pauseAll(true);
  await h.daemon.tick();
  assert.equal(h.fetch.calls.length, 0);
  assert.equal((await h.queue.list()).length, 0);

  await h.daemon.pauseAll(false);
  await h.daemon.pauseRepo("github.com/owner/nimbus", true);
  await h.daemon.tick();
  assert.equal((await h.queue.list()).length, 0, "暂停的 repo 不该进队列");
  assert.equal(h.fetch.calls.length, 0);

  await h.daemon.pauseRepo("github.com/owner/nimbus", false);
  await h.daemon.tick();
  assert.equal(h.fetch.calls.length, 1);
  h.cleanup();
});

test("daemon: refresh happens three minutes after a successful upload, per repo+branch", async () => {
  const refreshed = [];
  const h = harness({
    refreshBrief: async (target) => {
      refreshed.push(target);
      return { text: "b", fromCache: false };
    },
  });
  writeSession(h.file, [userRecord("上传", T0)]);
  await h.daemon.tick(); // 先读到
  h.advance(61_000);
  await h.daemon.tick();
  assert.equal(refreshed.length, 0, "刚上传还不刷新");

  h.advance(2 * 60_000);
  await h.daemon.tick();
  assert.equal(refreshed.length, 0, "3 分钟不到");

  h.advance(61_000);
  await h.daemon.tick();
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].repoKey, "github.com/owner/nimbus");
  assert.equal(refreshed[0].branch, "feature/x");
  h.cleanup();
});

test("daemon: bearer tokens never reach the log", async () => {
  const h = harness();
  writeSession(h.file, [userRecord("秘密", T0)]);
  await h.daemon.tick(); // 先读到
  h.advance(61_000);

  await h.daemon.tick();

  assert.ok(h.logs.length > 0);
  assert.ok(h.logs.every((line) => !line.includes("SECRET-TOKEN")));
  h.cleanup();
});

test("state: load/save round-trips atomically and a corrupt file falls back to empty", async () => {
  const root = tempDir();
  const state = emptyState("machine-xyz");
  state.sessions.k = { cursor: { inode: 7, offset: 42, seq: 3 } };
  await saveState(root, state);

  const loaded = await loadState(root);
  assert.equal(loaded.machine_id, "machine-xyz");
  assert.deepEqual(loaded.sessions.k.cursor, { inode: 7, offset: 42, seq: 3 });

  writeFileSync(path.join(root, "state.json"), "{ not json");
  const fallback = await loadState(root);
  assert.ok(fallback.machine_id.length > 0);
  assert.deepEqual(fallback.sessions, {});

  rmSync(root, { recursive: true, force: true });
});

test("lock: a second daemon on the same root is refused, a stale lock is taken over", async () => {
  const root = tempDir();

  const release = await acquireLock(root);
  await assert.rejects(() => acquireLock(root), /already running/);
  await release();

  writeFileSync(path.join(root, "agentd.lock"), JSON.stringify({ pid: 999_999, started_at: "x" }));
  const releaseAgain = await acquireLock(root);
  await releaseAgain();

  rmSync(root, { recursive: true, force: true });
});

test("logger: rotates at 5MB and keeps three archives", async () => {
  const root = tempDir();
  const file = path.join(root, "agentd.log");
  const logger = createRotatingLogger({ file, maxBytes: 200, keep: 3 });

  for (let i = 0; i < 40; i += 1) logger.info(`line ${i} ${"x".repeat(40)}`);
  await logger.flush();

  assert.ok(readFileSync(file, "utf8").length <= 320);
  assert.ok(readFileSync(`${file}.1`, "utf8").length > 0);
  assert.ok(readFileSync(`${file}.2`, "utf8").length > 0);

  rmSync(root, { recursive: true, force: true });
});

test("discovery: finds Claude sessions and Codex rollouts, skips everything else", async () => {
  const home = tempDir();
  writeSession(path.join(home, ".claude", "projects", "-tmp-a", "aaa.jsonl"), [userRecord("a", T0)]);
  writeSession(path.join(home, ".claude", "projects", "-tmp-a", "subagents", "sub.jsonl"), [userRecord("sub", T0)]);
  writeSession(path.join(home, ".codex", "sessions", "2026", "10", "17", "rollout-2026-10-17T05-00-00-bbbb.jsonl"), ['{"type":"session_meta","payload":{"id":"bbb"}}']);
  writeSession(path.join(home, ".codex", "sessions", "2026", "10", "17", "other.jsonl"), ["{}"]);

  const sources = await discoverSessionSources(home);

  assert.deepEqual(
    sources.map((s) => [s.agentKind, path.basename(s.file)]),
    [
      ["claude-code", "aaa.jsonl"],
      ["codex", "rollout-2026-10-17T05-00-00-bbbb.jsonl"],
    ],
  );
  rmSync(home, { recursive: true, force: true });
});

test("daemon: hook spool is the primary source, assigns seq, and session_end flushes + refreshes the brief immediately", async () => {
  const root = tempDir();
  const home = tempDir();
  const fetchImpl = fakeFetch(() => ({ status: 202, body: {} }));
  let clock = T0 + 1000;
  const refreshed = [];

  await appendSpoolRecord(root, "claude-code", "s1", {
    at: new Date(T0).toISOString(), kind: "message", role: "user", text: "hi", cwd: "/tmp/nimbus",
  });
  await appendSpoolRecord(root, "claude-code", "s1", { at: new Date(T0 + 1000).toISOString(), kind: "session_end" });

  const daemon = createDaemon(
    { root, apiBaseUrl: "https://api.test", machineId: "machine-1", tokens: { "claude-code": "t" }, home },
    {
      now: () => clock,
      fetch: fetchImpl,
      log: { info: () => {}, error: () => {} },
      getGitState: async () => ({ repo: { remote: null, branch: null }, git_state: null }),
      acquireLock: async () => async () => {},
      refreshBrief: async (target) => {
        refreshed.push(target);
        return { text: "brief", fromCache: false };
      },
    },
  );

  await daemon.tick();

  const uploads = fetchImpl.calls.filter((call) => call.url.includes("/api/v1/me/transcripts"));
  assert.equal(uploads.length, 1, "session_end must flush without waiting for idle");
  const body = uploads[0].body;
  assert.deepEqual(body.events.map((e) => [e.seq, e.kind]), [[1, "message"], [2, "session_end"]]);
  assert.equal(body.events[0].text, "hi");

  // 审查修复 3：session_end 上传成功后立刻刷一次 brief.md —— 这就是「退出 Claude
  // Code 立刻打开 Codex 说继续」能读到新简报的原因。
  assert.equal(refreshed.length, 1, "immediate refresh after a marker upload");
  assert.equal(refreshed[0].repoKey, "path:machine-1:/tmp/nimbus");

  // 总结防抖 + 模型跑完之后（这里按 150 秒近似）再刷一次，把整理好的交接单落盘。
  clock += 151_000;
  await daemon.tick();
  assert.equal(refreshed.length, 2, "post-summary refresh");

  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("daemon: transcript fallback stays off unless the agent is listed", async () => {
  const home = tempDir();
  const file = path.join(home, ".claude", "projects", "-tmp-nimbus", "fallback.jsonl");
  writeSession(file, [userRecord("兜底才看得到", T0)]);

  const offRoot = tempDir();
  const offFetch = fakeFetch(() => ({ status: 202, body: {} }));
  const off = createDaemon(
    { root: offRoot, apiBaseUrl: "https://api.test", machineId: "m1", tokens: { "claude-code": "t" }, home, transcriptFallback: [], batchLimit: 1 },
    { now: () => T0, fetch: offFetch, log: { info: () => {}, error: () => {} }, getGitState: async () => ({ repo: { remote: null, branch: null }, git_state: null }), acquireLock: async () => async () => {} },
  );
  await off.tick();
  assert.equal(offFetch.calls.length, 0, "fallback off by default");

  const onRoot = tempDir();
  const onFetch = fakeFetch(() => ({ status: 202, body: {} }));
  const on = createDaemon(
    { root: onRoot, apiBaseUrl: "https://api.test", machineId: "m1", tokens: { "claude-code": "t" }, home, transcriptFallback: ["claude-code"], batchLimit: 1 },
    { now: () => T0, fetch: onFetch, log: { info: () => {}, error: () => {} }, getGitState: async () => ({ repo: { remote: null, branch: null }, git_state: null }), acquireLock: async () => async () => {} },
  );
  await on.tick();
  assert.equal(onFetch.calls.length, 1);
  assert.equal(onFetch.calls[0].body.events[0].via, "transcript");

  rmSync(home, { recursive: true, force: true });
  rmSync(offRoot, { recursive: true, force: true });
  rmSync(onRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Assets-mode cloud sync cadence (C1): gated on the interval and on assets mode,
// fire-and-forget with an in-flight guard; a failure retries next interval.
// ---------------------------------------------------------------------------

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function seedAssetsMode(root, profileId = "p1") {
  writeFileSync(
    path.join(root, "accounts.json"),
    `${JSON.stringify({ "owner-1": { profile_id: profileId, default_soul_uid: "s1", soul_sync_mode: "assets_only" } })}\n`,
    { mode: 0o600 },
  );
}

test("daemon: assets-mode sync runs once per interval and is gated on assets mode", async () => {
  let syncCalls = 0;
  const h = harness({
    config: { syncIntervalMs: 10_000 },
    deps: {
      syncProfiles: async () => {
        syncCalls += 1;
        return [{ profile_id: "p1", report: { accepted: 1, conflicts: 0, pending: 0 } }];
      },
    },
  });
  seedAssetsMode(h.root);

  await h.daemon.tick();
  await flushMicrotasks();
  assert.equal(syncCalls, 1, "the first tick syncs");

  await h.daemon.tick();
  await flushMicrotasks();
  assert.equal(syncCalls, 1, "a second tick within the interval does not sync");

  h.advance(10_001);
  await h.daemon.tick();
  await flushMicrotasks();
  assert.equal(syncCalls, 2, "after the interval the next tick syncs again");

  h.cleanup();
});

test("daemon: sync is skipped entirely outside assets mode", async () => {
  let syncCalls = 0;
  const h = harness({
    config: { syncIntervalMs: 10_000 },
    deps: {
      syncProfiles: async () => {
        syncCalls += 1;
        return [{ profile_id: "p1", report: { accepted: 0, conflicts: 0, pending: 0 } }];
      },
    },
  });
  // No accounts.json -> legacy mode.

  await h.daemon.tick();
  await flushMicrotasks();
  h.advance(60_000);
  await h.daemon.tick();
  await flushMicrotasks();
  assert.equal(syncCalls, 0, "legacy mode never syncs");

  h.cleanup();
});

test("daemon: a failed sync retries next interval and never kills the tick loop", async () => {
  let syncCalls = 0;
  const h = harness({
    config: { syncIntervalMs: 10_000 },
    deps: {
      syncProfiles: async () => {
        syncCalls += 1;
        throw new Error("sync boom");
      },
    },
  });
  seedAssetsMode(h.root);

  await h.daemon.tick();
  await flushMicrotasks();
  assert.equal(syncCalls, 1, "the first attempt runs and fails");

  await h.daemon.tick();
  await flushMicrotasks();
  assert.equal(syncCalls, 1, "within the interval the failure is not retried next tick");

  h.advance(10_001);
  await h.daemon.tick();
  await flushMicrotasks();
  assert.equal(syncCalls, 2, "after the interval the failure retries");

  h.cleanup();
});
