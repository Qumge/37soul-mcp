#!/usr/bin/env node
/**
 * SessionStart hook：注入格式、超时预算、缓存兜底、stderr 隔离、绝不出凭据。
 * 另外覆盖 B 档的 repo 简报写盘与 git exclude 维护。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runHook, runHookCommand, wrapAdditionalContext } from "../dist/hook.js";
import { cachePath, refreshBrief, ensureExclude } from "../dist/agentd/brief-cache.js";
import { dataRoot } from "../dist/install.js";
import { loadState, saveConfig, saveState } from "../dist/agentd/state.js";
import { spoolFile } from "../dist/agentd/spool.js";
import { openStore } from "../dist/local/store.js";
import { startWriter } from "../dist/local/writer.js";
import "../dist/extraction/scheduler.js"; // register runtime_event in the in-process test writer
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const claudePayloads = JSON.parse(
  readFileSync(path.join(here, "fixtures", "runtimes", "claude-code", "payloads.json"), "utf8"),
);

function tempHome() {
  const home = mkdtempSync(path.join(tmpdir(), "37soul-hook-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

async function seedConfig(home, overrides = {}) {
  await saveConfig(dataRoot(home), {
    api_base_url: "https://app.test",
    machine_id: "m1",
    tokens: { "claude-code": "SECRET-TOKEN-xyz" },
    ...overrides,
  });
}

function capture() {
  const out = [];
  const err = [];
  return { stdout: (t) => out.push(t), stderr: (t) => err.push(t), out, err };
}

function payload(cwd = "/tmp/nimbus") {
  return JSON.stringify({ session_id: "s1", cwd, hook_event_name: "SessionStart", source: "startup" });
}

test("hook: prints exactly the observed SessionStart wrapper with the API brief", async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const io = capture();
  const fetchImpl = async () =>
    ({ ok: true, status: 200, async json() { return { text: "=== 37Soul brief ===\nGoal: ship pagination\n=== end ===" }; } });

  const code = await runHook({
    home,
    agentKind: "claude-code",
    fetch: fetchImpl,
    stdin: payload(),
    stdout: io.stdout,
    stderr: io.stderr,
    getGitState: async () => ({ repo: { remote: "git@github.com:owner/nimbus.git", branch: "feature/x" }, git_state: null }),
  });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  const parsed = JSON.parse(io.out[0]);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(parsed.hookSpecificOutput.additionalContext, /Goal: ship pagination/);
  assert.equal(io.err.length, 0);
  assert.equal(io.out.join("").includes("SECRET-TOKEN"), false);
  cleanup();
});

test("hook: falls back to the local cache when the API hangs, inside the 300ms budget", async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const io = capture();
  const hangingFetch = () => new Promise(() => {});

  // 缓存按 path key 存（git 也没来得及跑）。
  const key = "path:m1:/tmp/nimbus";
  const file = cachePath(dataRoot(home), key, "-");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "=== cached brief ===\nGoal: from cache\n=== end ===");

  const started = Date.now();
  const code = await runHook({
    home,
    agentKind: "claude-code",
    fetch: hangingFetch,
    stdin: payload(),
    stdout: io.stdout,
    stderr: io.stderr,
    timeoutMs: 120,
    getGitState: () => new Promise(() => {}),
  });
  const elapsed = Date.now() - started;

  assert.equal(code, 0);
  assert.ok(elapsed < 1000, `hook must not block startup (took ${elapsed}ms)`);
  const parsed = JSON.parse(io.out[0]);
  assert.match(parsed.hookSpecificOutput.additionalContext, /from cache/);
  cleanup();
});

test("hook: malformed stdin writes only to stderr and never crashes the session", async () => {
  const { home, cleanup } = tempHome();
  const io = capture();

  const code = await runHook({
    home,
    agentKind: "claude-code",
    fetch: async () => {
      throw new Error("must not be called");
    },
    stdin: "{ not json",
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(code, 0);
  assert.deepEqual(io.out, []);
  assert.ok(io.err.join("").includes("not valid JSON"));
  cleanup();
});

test("hook: an API failure keeps stdout valid (cache or nothing) and writes the reason to stderr", async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const io = capture();
  const failingFetch = async () => ({ ok: false, status: 500, async json() { return {}; } });

  const code = await runHook({
    home,
    agentKind: "claude-code",
    fetch: failingFetch,
    stdin: payload(),
    stdout: io.stdout,
    stderr: io.stderr,
    getGitState: async () => ({ repo: { remote: null, branch: null }, git_state: null }),
  });

  assert.equal(code, 0);
  assert.ok(io.err.join("").includes("answered 500"));
  // 没有缓存 → 什么都不注入，而不是注入错误文本
  assert.deepEqual(io.out, []);
  cleanup();
});

test("brief-cache: cache keys are per repo AND per branch (worktrees never share a stale brief)", async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const branch = new URL(String(url)).searchParams.get("branch");
    return { ok: true, status: 200, async json() { return { text: `brief for ${branch}`, etag: `etag-${branch}` }; } };
  };

  const base = { root, fetch: fetchImpl, baseUrl: "https://app.test", tokenFor: () => "T", machineId: "m1" };
  await refreshBrief(base, { agentKind: "claude-code", repoKey: "github.com/o/r", remote: "git@github.com:o/r.git", branch: "main" });
  await refreshBrief(base, { agentKind: "claude-code", repoKey: "github.com/o/r", remote: "git@github.com:o/r.git", branch: "feature/x" });

  assert.equal(readFileSync(cachePath(root, "github.com/o/r", "main"), "utf8"), "brief for main");
  assert.equal(readFileSync(cachePath(root, "github.com/o/r", "feature/x"), "utf8"), "brief for feature/x");
  cleanup();
});

test("brief-cache: API failure falls back to the cache, marked as such", async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const first = await refreshBrief(
    { root, fetch: async () => ({ ok: true, status: 200, async json() { return { text: "fresh", etag: "e1" }; } }), baseUrl: "https://app.test", tokenFor: () => "T", machineId: "m1" },
    { agentKind: "claude-code", repoKey: "github.com/o/r", remote: "git@github.com:o/r.git", branch: "main" },
  );
  assert.equal(first.fromCache, false);

  const second = await refreshBrief(
    { root, fetch: async () => { throw new Error("offline"); }, baseUrl: "https://app.test", tokenFor: () => "T", machineId: "m1" },
    { agentKind: "claude-code", repoKey: "github.com/o/r", remote: "git@github.com:o/r.git", branch: "main" },
  );

  assert.equal(second.fromCache, true);
  assert.equal(second.text, "fresh");
  cleanup();
});

test("brief-cache: 304 answers reuse the cache without rewriting", async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  let seenIfNoneMatch;
  const base = {
    root,
    baseUrl: "https://app.test",
    tokenFor: () => "T",
    machineId: "m1",
  };
  const target = { agentKind: "claude-code", repoKey: "github.com/o/r", remote: "git@github.com:o/r.git", branch: "main" };

  await refreshBrief(
    { ...base, fetch: async () => ({ ok: true, status: 200, async json() { return { text: "cached", etag: "etag-1" }; } }) },
    target,
  );
  const result = await refreshBrief(
    {
      ...base,
      fetch: async (_url, init) => {
        seenIfNoneMatch = init.headers["If-None-Match"];
        return { ok: false, status: 304, async json() { return {}; } };
      },
    },
    target,
  );

  assert.equal(seenIfNoneMatch, "etag-1");
  assert.equal(result.text, "cached");
  assert.equal(result.fromCache, false);
  cleanup();
});

test("ensureExclude: appends .37soul/ through `git rev-parse --git-path`, never touching user lines", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "37soul-worktree-"));
  const infoDir = path.join(dir, "real-gitdir", "info");
  mkdirSync(infoDir, { recursive: true });
  const exclude = path.join(infoDir, "exclude");
  writeFileSync(exclude, "# user entries\nnode_modules/\n");

  const runGit = async (args) => {
    assert.deepEqual(args, ["rev-parse", "--git-path", "info/exclude"]);
    return { code: 0, stdout: `${path.join(dir, "real-gitdir", "info", "exclude")}\n`, stderr: "" };
  };

  await ensureExclude(dir, runGit);
  const once = readFileSync(exclude, "utf8");
  assert.ok(once.includes("node_modules/"));
  assert.ok(once.includes(".37soul/"));
  assert.equal(once.split(".37soul/").length, 2);

  await ensureExclude(dir, runGit); // 幂等
  assert.equal(readFileSync(exclude, "utf8"), once);

  rmSync(dir, { recursive: true, force: true });
});

test("wrapAdditionalContext: exactly the wire shape Claude Code records", () => {
  const wrapper = JSON.parse(wrapAdditionalContext("hello"));
  assert.deepEqual(wrapper, {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "hello" },
  });
});

// ── v2：hook 命令（spool 写入 / 事件映射 / 暂停 / 静默） ─────────────────────

test('hook command: a tool event lands in the spool as one JSON line, stdout stays empty', async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const io = capture();

  const code = await runHookCommand({
    home,
    agentKind: 'claude-code',
    event: 'PostToolUse',
    fetch: async () => ({ ok: true, status: 200, async json() { return { text: 'brief' }; } }),
    stdin: JSON.stringify({
      session_id: 's1',
      cwd: '/tmp/nimbus',
      tool_name: 'Edit',
      tool_input: { file_path: 'app/models/foo.rb' },
      tool_response: { is_error: false },
    }),
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(code, 0);
  assert.deepEqual(io.out, []);
  const lines = readFileSync(spoolFile(dataRoot(home), 'claude-code', 's1'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'tool');
  assert.equal(lines[0].via, 'hook');
  assert.equal(lines[0].tool.name, 'Edit');
  assert.equal(lines[0].tool.input_summary, 'app/models/foo.rb');
  assert.equal(lines[0].cwd, '/tmp/nimbus');
  cleanup();
});

test('hook command: Stop records the assistant text from last_assistant_message', async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const io = capture();

  await runHookCommand({
    home, agentKind: 'claude-code', event: 'Stop',
    fetch: async () => { throw new Error('must not be called'); },
    stdin: JSON.stringify({ session_id: 's1', last_assistant_message: '好，收工。' }),
    stdout: io.stdout, stderr: io.stderr,
  });

  const [line] = readFileSync(spoolFile(dataRoot(home), 'claude-code', 's1'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(line.kind, 'message');
  assert.equal(line.role, 'assistant');
  assert.equal(line.text, '好，收工。');
  cleanup();
});

test('hook command: SessionStart writes session_start and injects the brief', async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const io = capture();

  await runHookCommand({
    home, agentKind: 'claude-code', event: 'SessionStart',
    fetch: async () => ({ ok: true, status: 200, async json() { return { text: '=== brief ===' }; } }),
    stdin: JSON.stringify({ session_id: 's1', cwd: '/tmp/nimbus', hook_event_name: 'SessionStart', source: 'startup' }),
    stdout: io.stdout, stderr: io.stderr,
    getGitState: async () => ({ repo: { remote: null, branch: null }, git_state: null }),
  });

  const [line] = readFileSync(spoolFile(dataRoot(home), 'claude-code', 's1'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(line.kind, 'session_start');
  assert.equal(line.source, 'startup');
  const wrapper = JSON.parse(io.out[0]);
  assert.equal(wrapper.hookSpecificOutput.additionalContext, '=== brief ===');
  cleanup();
});

test('hook command: PreCompact writes a compact event and a reinject marker', async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const io = capture();

  await runHookCommand({
    home, agentKind: 'claude-code', event: 'PreCompact',
    fetch: async () => { throw new Error('must not be called'); },
    stdin: JSON.stringify({ session_id: 's1' }),
    stdout: io.stdout, stderr: io.stderr,
  });

  const [line] = readFileSync(spoolFile(dataRoot(home), 'claude-code', 's1'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(line.kind, 'compact');
  const marker = JSON.parse(readFileSync(path.join(dataRoot(home), 'state', 's1.json'), 'utf8'));
  assert.equal(marker.needs_reinject, true);
  cleanup();
});

test('hook command: pause means nothing is captured at all', async () => {
  const { home, cleanup } = tempHome();
  await seedConfig(home);
  const state = await loadState(dataRoot(home));
  state.paused = true;
  await saveState(dataRoot(home), state);
  const io = capture();

  await runHookCommand({
    home, agentKind: 'claude-code', event: 'UserPromptSubmit',
    fetch: async () => { throw new Error('must not be called'); },
    stdin: JSON.stringify({ session_id: 's1', prompt: 'hi' }),
    stdout: io.stdout, stderr: io.stderr,
  });

  let spooled = '';
  try { spooled = readFileSync(spoolFile(dataRoot(home), 'claude-code', 's1'), 'utf8'); } catch { spooled = ''; }
  assert.equal(spooled, '');
  assert.deepEqual(io.out, []);
  cleanup();
});

test('hook command: malformed stdin exits 0 with empty stdout', async () => {
  const { home, cleanup } = tempHome();
  const io = capture();
  const code = await runHookCommand({
    home, agentKind: 'claude-code', event: 'Stop',
    fetch: async () => { throw new Error('must not be called'); },
    stdin: '{ not json', stdout: io.stdout, stderr: io.stderr,
  });
  assert.equal(code, 0);
  assert.deepEqual(io.out, []);
  cleanup();
});

test('hook command: assets-mode SessionStart injects the Soul context and records an injected receipt', async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const profileId = 'p1';
  const deviceId = 'dev-1';
  const sessionId = claudePayloads.session_start.session_id;

  // Seed an assets-only profile: a Soul, a bound native session and one current asset.
  mkdirSync(path.join(root, 'profiles', profileId), { recursive: true });
  writeFileSync(
    path.join(root, 'profiles', profileId, 'device.json'),
    `${JSON.stringify({ device_id: deviceId })}\n`,
    { mode: 0o600 },
  );
  const store = await openStore(root, profileId);
  await store.transact((d) => {
    d.owner_id = '123';
    d.cloud_device_uid = 'cdu';
    d.souls['s1'] = {
      soul_uid: 's1', legacy_host_id: null, identity_revision: 1,
      identity: { name: 'Growth', description: '', character: '', greeting: '' }, state: 'active',
    };
    d.consents['cdu:s1'] = {
      cloud_device_uid: 'cdu', soul_uid: 's1', revision: 1,
      categories: ['identity', 'relationship', 'experience'], enabled: true,
    };
    d.bindings[`${profileId}\u0000${deviceId}\u0000claude-code\u0000${sessionId}`] = {
      binding_uid: 'b1', session_ref: '30000000-0000-4000-8000-000000000001', runtime_kind: 'claude-code',
      soul_uid: 's1', revision: 1, state: 'bound', profile_id: profileId, device_id: deviceId, native_session_id: sessionId,
    };
    d.assets['a1'] = {
      asset_uid: 'a1', soul_uid: 's1', kind: 'relationship', trait: 'preference',
      content: '客户要先看真实付费证据，再讨论渠道', applicability: '客户分析', tags: [],
      evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal',
      state: 'active', revision: 1, supersedes_uid: null, pinned: false,
      source: { runtime_kind: 'claude-code', session_ref: '30000000-0000-4000-8000-000000000001', event_ref: 'e1', occurred_at: '2026-10-20T04:00:00Z' },
      sync_state: 'pending_sync', cloud_revision: null,
    };
  });
  await store.close();
  writeFileSync(
    path.join(root, 'accounts.json'),
    `${JSON.stringify({ 'owner-1': { profile_id: profileId, default_soul_uid: 's1', soul_sync_mode: 'assets_only' } })}\n`,
    { mode: 0o600 },
  );

  // The writer is required to record the injected receipt.
  const writer = await startWriter(root);

  const io = capture();
  await runHookCommand({
    home, agentKind: 'claude-code', event: 'SessionStart',
    fetch: async () => { throw new Error('the repo brief must not be fetched in assets mode'); },
    stdin: JSON.stringify({ ...claudePayloads.session_start, source: 'resume' }),
    stdout: io.stdout, stderr: io.stderr,
    getGitState: async () => { throw new Error('the repo brief must not be fetched in assets mode'); },
  });

  await writer.close();

  assert.equal(io.out.length, 1, 'the Soul context was injected');
  const wrapper = JSON.parse(io.out[0]);
  assert.equal(wrapper.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(wrapper.hookSpecificOutput.additionalContext, /客户要先看真实付费证据/);
  assert.ok(!wrapper.hookSpecificOutput.additionalContext.includes('brief'), 'no repo brief leaks into the Soul context');

  // The receipt is recorded as injected only after actual delivery.
  const store2 = await openStore(root, profileId);
  const snap = await store2.read();
  await store2.close();
  const receipts = Object.values(snap.receipts);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].stage, 'injected');
  assert.equal(receipts[0].binding_uid, 'b1');
  cleanup();
});

test('hook command: UserPromptSubmit uses the real task hint for relevant experience', async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const profileId = 'p1';
  const deviceId = 'dev-1';
  const sessionId = 'hint-session';
  mkdirSync(path.join(root, 'profiles', profileId), { recursive: true });
  writeFileSync(path.join(root, 'profiles', profileId, 'device.json'), `${JSON.stringify({ device_id: deviceId })}\n`, { mode: 0o600 });
  const store = await openStore(root, profileId);
  await store.transact((d) => {
    d.owner_id = '123';
    d.cloud_device_uid = 'cdu';
    d.souls['s1'] = { soul_uid: 's1', legacy_host_id: null, identity_revision: 1, identity: { name: 'Growth', description: '', character: '', greeting: '' }, state: 'active' };
    d.consents['cdu:s1'] = { cloud_device_uid: 'cdu', soul_uid: 's1', revision: 1, categories: ['identity', 'relationship', 'experience'], enabled: true };
    d.bindings[`${profileId}\u0000${deviceId}\u0000claude-code\u0000${sessionId}`] = {
      binding_uid: 'b1', session_ref: '30000000-0000-4000-8000-000000000001', runtime_kind: 'claude-code',
      soul_uid: 's1', revision: 1, state: 'bound', profile_id: profileId, device_id: deviceId, native_session_id: sessionId,
    };
    d.assets['exp1'] = {
      asset_uid: 'exp1', soul_uid: 's1', kind: 'experience', trait: 'fact',
      content: '产品验收先写验收结论，再列已证实和待验证', applicability: '产品验收', tags: [],
      evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal',
      state: 'active', revision: 1, supersedes_uid: null, pinned: false,
      source: { runtime_kind: 'claude-code', session_ref: '30000000-0000-4000-8000-000000000001', event_ref: 'e1', occurred_at: '2026-10-20T04:00:00Z' },
      sync_state: 'pending_sync', cloud_revision: null,
    };
  });
  await store.close();
  writeFileSync(path.join(root, 'accounts.json'), `${JSON.stringify({ 'owner-1': { profile_id: profileId, default_soul_uid: 's1', soul_sync_mode: 'assets_only' } })}\n`, { mode: 0o600 });
  const writer = await startWriter(root);
  const io = capture();
  await runHookCommand({
    home, agentKind: 'claude-code', event: 'UserPromptSubmit',
    fetch: async () => { throw new Error('no repo brief in assets mode'); },
    stdin: JSON.stringify({ session_id: sessionId, cwd: '/tmp/hint', hook_event_name: 'UserPromptSubmit', prompt: '产品验收应该怎么组织？' }),
    stdout: io.stdout, stderr: io.stderr,
    getGitState: async () => { throw new Error('no repo brief in assets mode'); },
  });
  await writer.close();
  assert.equal(io.out.length, 1);
  const wrapper = JSON.parse(io.out[0]);
  assert.equal(wrapper.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(wrapper.hookSpecificOutput.additionalContext, /产品验收先写验收结论/);
  cleanup();
});

test('hook command: each Stop selects its own latest turn and replay shares one range', async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const profileId = 'p1';
  const deviceId = 'dev-1';
  const sessionId = 'two-turn-session';
  const transcriptPath = path.join(home, 'two-turn.jsonl');
  const transcript = [
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'first preference' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'first noted' }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'second preference' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'second noted' }] } }),
  ].join('\n');
  writeFileSync(transcriptPath, transcript, { mode: 0o600 });

  mkdirSync(path.join(root, 'profiles', profileId), { recursive: true });
  writeFileSync(path.join(root, 'profiles', profileId, 'device.json'), `${JSON.stringify({ device_id: deviceId })}\n`, { mode: 0o600 });
  const store = await openStore(root, profileId);
  await store.transact((d) => {
    d.owner_id = '123';
    d.cloud_device_uid = 'cdu';
    d.souls['s1'] = {
      soul_uid: 's1', legacy_host_id: null, identity_revision: 1,
      identity: { name: 'Growth', description: '', character: '', greeting: '' }, state: 'active',
    };
    d.consents['cdu:s1'] = { cloud_device_uid: 'cdu', soul_uid: 's1', revision: 1, categories: ['identity', 'relationship', 'experience'], enabled: true };
    d.bindings[`${profileId}\u0000${deviceId}\u0000claude-code\u0000${sessionId}`] = {
      binding_uid: 'b1', session_ref: '30000000-0000-4000-8000-000000000001', runtime_kind: 'claude-code',
      soul_uid: 's1', revision: 1, state: 'bound', profile_id: profileId, device_id: deviceId, native_session_id: sessionId,
    };
  });
  await store.close();
  writeFileSync(
    path.join(root, 'accounts.json'),
    `${JSON.stringify({ 'owner-1': { profile_id: profileId, default_soul_uid: 's1', soul_sync_mode: 'assets_only' } })}\n`,
    { mode: 0o600 },
  );

  const writer = await startWriter(root);
  const stop = (event, last) => runHookCommand({
    home, agentKind: 'claude-code', event,
    fetch: async () => { throw new Error('no repo brief in assets mode'); },
    stdin: JSON.stringify({ session_id: sessionId, cwd: home, hook_event_name: event, transcript_path: transcriptPath, last_assistant_message: last }),
    stdout: () => {}, stderr: () => {},
    getGitState: async () => { throw new Error('no repo brief in assets mode'); },
  });
  await stop('Stop', 'second noted');
  await stop('Stop', 'second noted');
  await stop('SessionEnd', 'second noted');
  await writer.close();

  const after = await openStore(root, profileId);
  const snap = await after.read();
  await after.close();
  const watermarks = Object.values(snap.extraction_watermarks);
  assert.equal(watermarks.length, 1, 'Stop/SessionEnd replay created one extraction range');
  assert.deepEqual(watermarks[0].request.source_turn_refs, ['u2', 'a2'], 'the second turn, not the first turn');
  assert.equal(watermarks[0].attempts, 0, 'lifecycle enqueue does not spend a model attempt');
  cleanup();
});

test('hook command: first SessionStart waits for writer-created binding before injecting', async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const profileId = 'p1';
  const deviceId = 'dev-1';
  const sessionId = 'first-session-no-binding';

  mkdirSync(path.join(root, 'profiles', profileId), { recursive: true });
  writeFileSync(
    path.join(root, 'profiles', profileId, 'device.json'),
    `${JSON.stringify({ device_id: deviceId })}\n`,
    { mode: 0o600 },
  );
  const store = await openStore(root, profileId);
  await store.transact((d) => {
    d.owner_id = '123';
    d.cloud_device_uid = 'cdu';
    d.souls['s1'] = {
      soul_uid: 's1', legacy_host_id: null, identity_revision: 1,
      identity: { name: 'Growth', description: '', character: '', greeting: '' }, state: 'active',
    };
    d.consents['cdu:s1'] = {
      cloud_device_uid: 'cdu', soul_uid: 's1', revision: 1,
      categories: ['identity', 'relationship', 'experience'], enabled: true,
    };
    d.assets['a1'] = {
      asset_uid: 'a1', soul_uid: 's1', kind: 'relationship', trait: 'preference',
      content: '首次会话也必须看到这条偏好', applicability: '客户分析', tags: [],
      evidence: 'explicit_user_statement', verification: 'unverified', sensitivity: 'normal',
      state: 'active', revision: 1, supersedes_uid: null, pinned: false,
      source: { runtime_kind: 'claude-code', session_ref: '30000000-0000-4000-8000-000000000001', event_ref: 'e1', occurred_at: '2026-10-20T04:00:00Z' },
      sync_state: 'pending_sync', cloud_revision: null,
    };
  });
  await store.close();
  writeFileSync(
    path.join(root, 'accounts.json'),
    `${JSON.stringify({ 'owner-1': { profile_id: profileId, default_soul_uid: 's1', soul_sync_mode: 'assets_only' } })}\n`,
    { mode: 0o600 },
  );

  const writer = await startWriter(root);
  const io = capture();
  await runHookCommand({
    home, agentKind: 'claude-code', event: 'SessionStart',
    fetch: async () => { throw new Error('no repo brief in assets mode'); },
    stdin: JSON.stringify({ session_id: sessionId, cwd: '/tmp/first', hook_event_name: 'SessionStart', source: 'startup' }),
    stdout: io.stdout, stderr: io.stderr,
    getGitState: async () => { throw new Error('no repo brief in assets mode'); },
  });
  await writer.close();

  assert.equal(io.out.length, 1, 'first SessionStart injected context');
  const wrapper = JSON.parse(io.out[0]);
  assert.match(wrapper.hookSpecificOutput.additionalContext, /首次会话也必须看到这条偏好/);

  const after = await openStore(root, profileId);
  const snap = await after.read();
  await after.close();
  const bindings = Object.values(snap.bindings).filter((binding) => binding.native_session_id === sessionId);
  assert.equal(bindings.length, 1, 'writer created exactly one binding before injection');
  const receipts = Object.values(snap.receipts);
  assert.equal(receipts.length, 1, 'injected receipt was recorded after delivery');
  assert.equal(receipts[0].binding_uid, bindings[0].binding_uid);
  cleanup();
});

test('hook command: revoked identity never injects the downloaded cloud canary', async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const profileId = 'p1';
  const deviceId = 'dev-1';
  const sessionId = claudePayloads.session_start.session_id;
  mkdirSync(path.join(root, 'profiles', profileId), { recursive: true });
  writeFileSync(
    path.join(root, 'profiles', profileId, 'device.json'),
    `${JSON.stringify({ device_id: deviceId })}\n`,
    { mode: 0o600 },
  );
  const store = await openStore(root, profileId);
  await store.transact((d) => {
    d.owner_id = '123';
    d.cloud_device_uid = 'cdu';
    d.souls['s1'] = {
      soul_uid: 's1', legacy_host_id: 7, identity_revision: 1,
      identity: { name: 'OWNER_PRIVATE_IDENTITY_CANARY', description: 'private cloud', character: '', greeting: '' },
      state: 'active', origin: 'cloud',
    };
    d.consents['cdu:s1'] = {
      cloud_device_uid: 'cdu', soul_uid: 's1', revision: 2, categories: [], enabled: false,
    };
    d.bindings[`${profileId}\u0000${deviceId}\u0000claude-code\u0000${sessionId}`] = {
      binding_uid: 'b1', session_ref: '30000000-0000-4000-8000-000000000001', runtime_kind: 'claude-code',
      soul_uid: 's1', revision: 1, state: 'bound', profile_id: profileId, device_id: deviceId, native_session_id: sessionId,
    };
  });
  await store.close();
  writeFileSync(
    path.join(root, 'accounts.json'),
    `${JSON.stringify({ 'owner-1': { profile_id: profileId, default_soul_uid: 's1', soul_sync_mode: 'assets_only' } })}\n`,
    { mode: 0o600 },
  );
  const writer = await startWriter(root);
  const io = capture();
  try {
    await runHookCommand({
      home, agentKind: 'claude-code', event: 'SessionStart',
      fetch: async () => { throw new Error('no brief in assets mode'); },
      stdin: JSON.stringify({ ...claudePayloads.session_start, source: 'resume' }),
      stdout: io.stdout, stderr: io.stderr,
      getGitState: async () => { throw new Error('no git state'); },
    });
  } finally {
    await writer.close();
  }
  assert.deepEqual(io.out, [], 'nothing is injected after identity revocation');
  assert.ok(!io.err.join('').includes('OWNER_PRIVATE_IDENTITY_CANARY'), 'the canary never reaches stderr either');
  cleanup();
});

test('hook command: anonymous local edit is what the next SessionStart injects', async () => {
  const { home, cleanup } = tempHome();
  const root = dataRoot(home);
  const profileId = 'p1';
  const deviceId = 'dev-1';
  const sessionId = claudePayloads.session_start.session_id;
  mkdirSync(path.join(root, 'profiles', profileId), { recursive: true });
  writeFileSync(
    path.join(root, 'profiles', profileId, 'device.json'),
    `${JSON.stringify({ device_id: deviceId })}\n`,
    { mode: 0o600 },
  );
  const store = await openStore(root, profileId);
  await store.transact((d) => {
    d.owner_id = null;
    d.cloud_device_uid = null;
    d.souls['s1'] = {
      soul_uid: 's1', legacy_host_id: null, identity_revision: 2,
      identity: { name: 'Growth', description: '', character: 'UPDATED_LOCAL_CANARY', greeting: '' },
      state: 'active', origin: 'local',
      local_identity: { name: 'Growth', description: '', character: 'UPDATED_LOCAL_CANARY', greeting: '' },
      local_identity_revision: 2,
    };
    d.bindings[`${profileId}\u0000${deviceId}\u0000claude-code\u0000${sessionId}`] = {
      binding_uid: 'b1', session_ref: '30000000-0000-4000-8000-000000000001', runtime_kind: 'claude-code',
      soul_uid: 's1', revision: 1, state: 'bound', profile_id: profileId, device_id: deviceId, native_session_id: sessionId,
    };
    d.assets['a1'] = {
      asset_uid: 'a1', soul_uid: 's1', kind: 'relationship', trait: 'preference',
      content: '本地偏好', applicability: '', tags: [], evidence: 'explicit_user_statement',
      verification: 'unverified', sensitivity: 'normal', state: 'active', revision: 1,
      supersedes_uid: null, pinned: false,
      source: { runtime_kind: 'claude-code', session_ref: '30000000-0000-4000-8000-000000000001', event_ref: 'e1', occurred_at: '2026-10-20T04:00:00Z' },
      sync_state: 'local_only', cloud_revision: null,
    };
  });
  await store.close();
  writeFileSync(
    path.join(root, 'accounts.json'),
    `${JSON.stringify({ anonymous: { profile_id: profileId, default_soul_uid: 's1', soul_sync_mode: 'assets_only' } })}\n`,
    { mode: 0o600 },
  );
  const writer = await startWriter(root);
  const io = capture();
  try {
    await runHookCommand({
      home, agentKind: 'claude-code', event: 'SessionStart',
      fetch: async () => { throw new Error('no repo brief'); },
      stdin: JSON.stringify({ ...claudePayloads.session_start, source: 'resume' }),
      stdout: io.stdout, stderr: io.stderr,
      getGitState: async () => { throw new Error('no git state'); },
    });
  } finally {
    await writer.close();
  }
  const wrapped = io.out.join('');
  assert.match(wrapped, /UPDATED_LOCAL_CANARY/, 'the hook renders the edited local identity');
  assert.doesNotMatch(wrapped, /ORIGINAL_LOCAL_CANARY/, 'the old local identity is gone');
  cleanup();
});
