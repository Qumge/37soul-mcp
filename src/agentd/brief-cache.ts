/**
 * 开局简报的本地缓存与 B 档写盘（设计 §6.2 / §6.4）。
 *
 *   · 本地缓存 ~/.37soul/cache/<repo_key>__<branch>.md —— hook（A 档）超时/失败
 *     时读它；按 repo+branch 分开，worktree 之间不互相读到过期的简报。
 *   · B 档：刷新成功后写 <repo>/.37soul/brief.md，并确保 `.37soul/` 在
 *     `.git/info/exclude` 里 —— 用 `git rev-parse --git-path info/exclude`
 *     解析（worktree 里 `.git` 是个文件，拼路径会拼错）；只追加缺失的那一行，
 *     从不覆盖用户的 ignore 条目。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

export interface CachedBrief {
  text: string;
  etag?: string;
}

export interface BriefFetchResult {
  text: string;
  fromCache: boolean;
  etag?: string;
}

export interface BriefCacheOptions {
  root: string;
  fetch: typeof fetch;
  baseUrl: string;
  tokenFor: (agentKind: string) => string | null;
  machineId: string;
  runGit?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  log?: { info: (m: string) => void; error: (m: string) => void };
}

export interface BriefTarget {
  agentKind: string;
  repoKey: string;
  remote?: string | null;
  branch?: string | null;
  cwd?: string | null;
  head?: string | null;
}

const EXCLUDE_ENTRY = ".37soul/";

export function cachePath(root: string, repoKey: string, branch?: string | null): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_");
  // v2 §6.3：缓存按 repo_key / branch 分层 —— worktree 和分支之间不互相读到过期简报。
  return path.join(root, "cache", safe(repoKey), `${safe(branch || "-")}.md`);
}

export function etagPath(root: string, repoKey: string, branch?: string | null): string {
  return `${cachePath(root, repoKey, branch)}.etag`;
}

export async function readCachedBrief(root: string, repoKey: string, branch?: string | null): Promise<CachedBrief | null> {
  try {
    const text = await readFile(cachePath(root, repoKey, branch), "utf8");
    if (text.trim() === "") return null;
    let etag: string | undefined;
    try {
      etag = (await readFile(etagPath(root, repoKey, branch), "utf8")).trim() || undefined;
    } catch {
      etag = undefined;
    }
    return { text, etag };
  } catch {
    return null;
  }
}

export async function refreshBrief(opts: BriefCacheOptions, target: BriefTarget): Promise<BriefFetchResult> {
  const log = opts.log ?? { info: () => {}, error: () => {} };
  const token = opts.tokenFor(target.agentKind);
  const cached = await readCachedBrief(opts.root, target.repoKey, target.branch);

  if (token) {
    const params = new URLSearchParams();
    if (target.remote) params.set("repo", target.remote);
    if (target.branch) params.set("branch", target.branch);
    if (target.cwd) params.set("cwd", target.cwd);
    params.set("machine_id", opts.machineId);
    if (target.head) params.set("head", target.head);
    params.set("agent_kind", target.agentKind);

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (cached?.etag) headers["If-None-Match"] = cached.etag;

      const response = await opts.fetch(`${opts.baseUrl.replace(/\/$/, "")}/api/v1/me/brief?${params}`, { headers });
      if (response.status === 304 && cached) {
        await writeRepoBrief(target.cwd, cached.text, opts.runGit);
        return { text: cached.text, fromCache: false, etag: cached.etag };
      }
      if (response.ok) {
        const body = (await response.json()) as { text?: string; etag?: string };
        if (typeof body.text === "string" && body.text !== "") {
          await mkdir(path.dirname(cachePath(opts.root, target.repoKey, target.branch)), { recursive: true, mode: 0o700 });
          await writeFile(cachePath(opts.root, target.repoKey, target.branch), body.text, { mode: 0o600 });
          if (typeof body.etag === "string") {
            await writeFile(etagPath(opts.root, target.repoKey, target.branch), body.etag, { mode: 0o600 });
          }
          await writeRepoBrief(target.cwd, body.text, opts.runGit);
          return { text: body.text, fromCache: false, etag: body.etag };
        }
      }
      log.error(`brief refresh failed (HTTP ${response.status}) for ${target.repoKey}@${target.branch}`);
    } catch (error) {
      log.error(`brief refresh failed (${(error as Error).message}) for ${target.repoKey}@${target.branch}`);
    }
  }

  if (cached) return { text: cached.text, fromCache: true, etag: cached.etag };
  return { text: "", fromCache: true };
}

/** B 档：写 <repo>/.37soul/brief.md 并把 `.37soul/` 加进 git exclude。 */
export async function writeRepoBrief(
  cwd: string | null | undefined,
  text: string,
  runGit?: BriefCacheOptions["runGit"],
): Promise<void> {
  if (!cwd) return;
  try {
    await mkdir(path.join(cwd, ".37soul"), { recursive: true });
    await writeFile(path.join(cwd, ".37soul", "brief.md"), text, { mode: 0o600 });
    await ensureExclude(cwd, runGit);
  } catch {
    // 目录不可写（只读挂载等）：简报写不进去不该让采集失败。
  }
}

export async function ensureExclude(
  cwd: string,
  runGit: BriefCacheOptions["runGit"] = defaultRunGit,
): Promise<void> {
  const result = await runGit(["rev-parse", "--git-path", "info/exclude"], cwd);
  if (result.code !== 0) return; // 不是 git 仓库：没有 exclude 可维护

  const excludePath = path.isAbsolute(result.stdout.trim()) ? result.stdout.trim() : path.join(cwd, result.stdout.trim());
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.split("\n");
  if (lines.some((line) => line.trim() === EXCLUDE_ENTRY)) return; // 已经有了，别写第二遍

  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${existing}${separator}${EXCLUDE_ENTRY}\n`);
}

function defaultRunGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 5000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
