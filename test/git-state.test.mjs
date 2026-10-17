#!/usr/bin/env node
/**
 * git 快照：真实临时仓库（remote/branch/head/脏文件/diffstat/ahead-behind），
 * 特殊的文件名原样保留，缓存 10 秒（注入时钟，不 sleep）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getGitState, parsePorcelain, parseShortstat, resetGitStateCache } from "../dist/agentd/git-state.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "agentd-git-"));
  git(dir, "init", "-q", "-b", "feature/x");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "app.rb"), "puts 1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial commit");
  git(dir, "remote", "add", "origin", "git@github.com:owner/repo.git");
  return dir;
}

test("git-state: collects remote, branch, head, dirty files and diffstat", async () => {
  resetGitStateCache();
  const dir = makeRepo();
  writeFileSync(path.join(dir, "app.rb"), "puts 1\nputs 2\n");
  writeFileSync(path.join(dir, "名字 带空格 (1).txt"), "unicode name\n");
  git(dir, "add", "名字 带空格 (1).txt"); // 未跟踪的文件不进 git diff；暂存后才算「未提交的改动」

  const result = await getGitState(dir);

  assert.equal(result.repo.remote, "git@github.com:owner/repo.git");
  assert.equal(result.repo.branch, "feature/x");
  assert.equal(result.git_state.branch, "feature/x");
  assert.equal(result.git_state.head.length, 12);
  assert.equal(result.git_state.head_subject, "initial commit");
  assert.deepEqual(result.git_state.dirty_files.sort(), ["app.rb", "名字 带空格 (1).txt"].sort());
  assert.equal(result.git_state.diffstat.files, 2);

  rmSync(dir, { recursive: true, force: true });
});

test("git-state: a non-repo directory degrades to nulls, never throws", async () => {
  resetGitStateCache();
  const dir = mkdtempSync(path.join(tmpdir(), "agentd-norepo-"));

  const result = await getGitState(dir);

  assert.deepEqual(result, { repo: { remote: null, branch: null }, git_state: null });
  rmSync(dir, { recursive: true, force: true });
});

test("git-state: caches per cwd for 10 seconds", async () => {
  resetGitStateCache();
  let calls = 0;
  let clock = 1_000_000;
  const run = async (args, cwd) => {
    calls += 1;
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true\n", stderr: "" };
    if (args[0] === "remote" && args[1] === "get-url") return { code: 0, stdout: "git@example.com:a/b.git\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };

  await getGitState("/tmp/fake", { run, now: () => clock });
  const afterFirst = calls;
  await getGitState("/tmp/fake", { run, now: () => clock });
  assert.equal(calls, afterFirst, "第二次在 TTL 内不该再跑 git");

  clock += 10_001;
  await getGitState("/tmp/fake", { run, now: () => clock });
  assert.ok(calls > afterFirst, "TTL 过了要重新采");
});

test("git-state: porcelain -z parsing keeps names raw and skips rename origins", () => {
  const output = " M app.rb\0?? 名字 带空格 (1).txt\0R  new-name.txt\0old-name.txt\0";
  assert.deepEqual(parsePorcelain(output), ["app.rb", "名字 带空格 (1).txt", "new-name.txt"]);
});

test("git-state: shortstat parsing", () => {
  assert.deepEqual(parseShortstat(" 3 files changed, 40 insertions(+), 5 deletions(-)"), { files: 3, insertions: 40, deletions: 5 });
  assert.deepEqual(parseShortstat(" 1 file changed, 2 insertions(+)"), { files: 1, insertions: 2 });
  assert.deepEqual(parseShortstat(""), {});
});
