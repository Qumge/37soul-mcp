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

import { runHook, wrapAdditionalContext } from "../dist/hook.js";
import { cachePath, refreshBrief, ensureExclude } from "../dist/agentd/brief-cache.js";
import { dataRoot } from "../dist/install.js";
import { saveConfig } from "../dist/agentd/state.js";

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
