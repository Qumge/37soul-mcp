/**
 * 从 cwd 采集 git 快照（设计 §5.1 / §6.2）。同一个 cwd 的结果缓存 10 秒：
 * 一次上传里同一个目录只查一遍，别把 git 当免费。
 *
 * ⚠️ 一切都是「尽力而为」：不是 git 仓库、没有 origin、空仓库、git 不存在 ——
 * 都返回 null / 缺字段，绝不抛错打断上传。
 */

import { execFile } from "node:child_process";
import type { GitState } from "./types.js";

export interface RepositoryIdentity {
  remote: string | null;
  branch: string | null;
}

export interface GitStateResult {
  repo: RepositoryIdentity;
  git_state: GitState | null;
}

export type RunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface GitStateOptions {
  run?: RunGit;
  now?: () => number;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 10_000;
const DIRTY_FILES_MAX = 50;

const cache = new Map<string, { at: number; value: GitStateResult }>();

export async function getGitState(cwd: string, opts: GitStateOptions = {}): Promise<GitStateResult> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cached = cache.get(cwd);
  if (cached && now() - cached.at < ttlMs) return cached.value;

  const value = await collect(cwd, opts.run ?? defaultRun);
  cache.set(cwd, { at: now(), value });
  return value;
}

export function resetGitStateCache(): void {
  cache.clear();
}

async function collect(cwd: string, run: RunGit): Promise<GitStateResult> {
  const empty: GitStateResult = { repo: { remote: null, branch: null }, git_state: null };

  const inside = await run(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return empty;

  const remote = await resolveRemote(cwd, run);
  const branchRaw = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = branchRaw.code === 0 && branchRaw.stdout.trim() !== "" && branchRaw.stdout.trim() !== "HEAD"
    ? branchRaw.stdout.trim()
    : null;

  const headRaw = await run(["rev-parse", "HEAD"], cwd);
  const head = headRaw.code === 0 ? headRaw.stdout.trim() : undefined;

  const subjectRaw = await run(["log", "-1", "--pretty=%s"], cwd);
  const headSubject = subjectRaw.code === 0 && subjectRaw.stdout.trim() !== "" ? subjectRaw.stdout.trim() : undefined;

  const statusRaw = await run(["status", "--porcelain", "-z"], cwd);
  const dirtyFiles = statusRaw.code === 0 ? parsePorcelain(statusRaw.stdout) : [];

  const diffRaw = await run(["diff", "--shortstat", "HEAD"], cwd);
  const diffFallback = diffRaw.code === 0 ? diffRaw : await run(["diff", "--shortstat"], cwd);
  const diffstat = diffFallback.code === 0 ? parseShortstat(diffFallback.stdout) : {};

  const countsRaw = await run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd);
  let ahead: number | undefined;
  let behind: number | undefined;
  if (countsRaw.code === 0) {
    const [a, b] = countsRaw.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (Number.isInteger(a) && Number.isInteger(b)) {
      ahead = a;
      behind = b;
    }
  }

  const gitState: GitState = {};
  if (branch) gitState.branch = branch;
  if (head) gitState.head = head.slice(0, 12);
  if (headSubject) gitState.head_subject = headSubject;
  if (dirtyFiles.length > 0) gitState.dirty_files = dirtyFiles.slice(0, DIRTY_FILES_MAX);
  if (Object.keys(diffstat).length > 0) gitState.diffstat = diffstat;
  if (ahead !== undefined) gitState.ahead = ahead;
  if (behind !== undefined) gitState.behind = behind;

  return {
    repo: { remote, branch: branch ?? null },
    git_state: Object.keys(gitState).length > 0 ? gitState : null,
  };
}

async function resolveRemote(cwd: string, run: RunGit): Promise<string | null> {
  const origin = await run(["remote", "get-url", "origin"], cwd);
  if (origin.code === 0 && origin.stdout.trim() !== "") return origin.stdout.trim();

  const list = await run(["remote"], cwd);
  if (list.code !== 0) return null;
  const first = list.stdout.split("\n").map((s) => s.trim()).find((s) => s !== "");
  if (!first) return null;

  const url = await run(["remote", "get-url", first], cwd);
  return url.code === 0 && url.stdout.trim() !== "" ? url.stdout.trim() : null;
}

/** `git status --porcelain -z`：NUL 分隔，文件名原样不转义。 */
export function parsePorcelain(output: string): string[] {
  const records = output.split("\0").filter((r) => r !== "");
  const files: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    files.push(record.slice(3));
    // rename/copy：下一条记录是来源路径，不是另一个脏文件。
    if (code.includes("R") || code.includes("C")) i += 1;
  }
  return files;
}

/** ` 3 files changed, 40 insertions(+), 5 deletions(-)` */
export function parseShortstat(output: string): { files?: number; insertions?: number; deletions?: number } {
  const match = /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/.exec(output);
  if (!match) return {};
  const result: { files?: number; insertions?: number; deletions?: number } = { files: Number.parseInt(match[1], 10) };
  if (match[2] !== undefined) result.insertions = Number.parseInt(match[2], 10);
  if (match[3] !== undefined) result.deletions = Number.parseInt(match[3], 10);
  return result;
}

function defaultRun(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
