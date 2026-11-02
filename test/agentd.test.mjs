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

// Old retry/status cases now assert a stronger contract: no raw HTTP at all,
// no queue deletion, and no delayed brief refresh, whatever an old server would return.
for (const status of [200, 202, 401, 409, 413, 422, 429, 500]) {
  test(`daemon: retired queue remains unchanged instead of contacting HTTP ${status}`, async () => {
    let refreshes = 0;
    const h = harness({ fetch: fakeFetch(() => ({ status })), refreshBrief: async () => { refreshes++; return {text:'brief',fromCache:false}; } });
    try {
      await h.queue.enqueue(queuedItem());
      const before = await h.queue.list();
      writeSession(h.file, [userRecord('PRIVATE-RAW', T0)]);
      await h.daemon.scan();
      await h.daemon.processQueue();
      await h.daemon.tick();
      h.advance(10 * 60_000);
      await h.daemon.tick();
      assert.deepEqual(h.fetch.calls, []);
      assert.deepEqual(await h.queue.list(), before);
      assert.equal(refreshes, 0);
      assert.deepEqual(h.daemon.blockedAgents(), []);
      assert.ok(h.logs.every(line => !line.includes('SECRET-TOKEN') && !line.includes('PRIVATE-RAW')));
    } finally { await h.daemon.stop(); h.cleanup(); }
  });
}

test('daemon: pause and resume preserve durable preferences and raw queue', async () => {
  const h = harness();
  try {
    await h.queue.enqueue(queuedItem()); const before = await h.queue.list();
    await h.daemon.pauseAll(true); await h.daemon.pauseRepo('repo-key', true);
    await h.daemon.tick();
    assert.equal(h.daemon.state().paused, true);
    assert.deepEqual(h.daemon.state().paused_repos, ['repo-key']);
    await h.daemon.resumeAll(); await h.daemon.tick();
    assert.equal(h.daemon.state().paused, false);
    assert.deepEqual(h.daemon.state().paused_repos, []);
    assert.deepEqual(await h.queue.list(), before);
    assert.deepEqual(h.fetch.calls, []);
  } finally { await h.daemon.stop(); h.cleanup(); }
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

test('daemon: raw spool and transcript fallback are never discovered, mutated or trimmed', async () => {
  const h = harness({config:{transcriptFallback:['claude-code'],batchLimit:1}});
  try {
    const file = await appendSpoolRecord(h.root, 'claude-code', 's1', {at:new Date(T0).toISOString(),kind:'message',role:'user',text:'PRIVATE-RAW'});
    const spoolPath = path.join(h.root,'spool','claude-code','s1.jsonl');
    const before = readFileSync(spoolPath, 'utf8');
    writeSession(h.file, [userRecord('PRIVATE-RAW', T0)]);
    await h.daemon.tick(); h.advance(600_000); await h.daemon.tick();
    assert.equal(readFileSync(spoolPath,'utf8'),before);
    assert.deepEqual(h.fetch.calls, []);
    assert.deepEqual(await h.queue.list(), []);
  } finally { await h.daemon.stop(); h.cleanup(); }
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
