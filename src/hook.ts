/**
 * SessionStart hook（A 档，Claude Code；设计 §6.4）。
 *
 * 契约（实测）：
 *   · stdin 是 hook 的 JSON 载荷（含 cwd）；
 *   · stdout **只有**一行 JSON：
 *     {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
 *   · 任何错误、超时都只写 stderr 并 exit 0 —— 绝不能因为简报拿不到就让会话起不来；
 *   · 输出里不含任何凭据（token 只在请求头里）。
 *
 * 总预算 300ms：先试 API（超时/失败）→ 用 ~/.37soul/cache 的本地缓存兜底。
 */

import type { GitStateResult } from "./agentd/git-state.js";
import { getGitState } from "./agentd/git-state.js";
import { dataRoot } from "./install.js";
import { cachePath } from "./agentd/brief-cache.js";
import { loadConfig } from "./agentd/state.js";
import { repoKey } from "./repo-key.js";

export interface HookDeps {
  home: string;
  agentKind: string;
  fetch: typeof fetch;
  stdin: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  getGitState?: (cwd: string) => Promise<GitStateResult>;
  /** 整体预算，默认 250ms。 */
  timeoutMs?: number;
}

interface HookPayload {
  cwd?: string;
  session_id?: string;
  hook_event_name?: string;
}

export function wrapAdditionalContext(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  });
}

export async function runHook(deps: HookDeps): Promise<number> {
  // ⚠️ 250 而不是设计里的 300：300 是「API 超时」的候选值，而验收指标是「hook 让
  // 启动变慢不超过 300ms」——整体预算。API 在 300ms 才放弃时，缓存兜底 + 打印会
  // 把它推过 300（实测 301.5ms）。250 给本地收尾留出余量，而 brief 的 P95 只有
  // ~14ms，真实请求几乎永远用不到这个上限。
  const timeoutMs = deps.timeoutMs ?? 250;

  let payload: HookPayload;
  try {
    payload = JSON.parse(deps.stdin) as HookPayload;
  } catch {
    deps.stderr("37soul hook: stdin was not valid JSON — skipping injection\n");
    return 0;
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;

  try {
    const text = await withBudget(timeoutMs, () => resolveBrief(deps, cwd));
    if (text.trim() !== "") deps.stdout(`${wrapAdditionalContext(text)}\n`);
    return 0;
  } catch (error) {
    // 超时或任何故障：尝试最便宜的本地兜底（只用 cwd+machine_id 的 path key）。
    const fallback = await fallbackFromCache(deps, cwd);
    if (fallback) deps.stdout(`${wrapAdditionalContext(fallback)}\n`);
    else deps.stderr(`37soul hook: no brief available (${(error as Error).message})\n`);
    return 0;
  }
}

async function resolveBrief(deps: HookDeps, cwd: string | null): Promise<string> {
  const root = dataRoot(deps.home);
  const config = await loadConfig(root);
  if (!config) return "";

  let git: GitStateResult | null = null;
  if (cwd) {
    try {
      git = await (deps.getGitState ?? getGitState)(cwd);
    } catch {
      git = null;
    }
  }
  const remote = git?.repo.remote ?? null;
  const branch = git?.repo.branch ?? null;
  const key = repoKey({ remote, machineId: config.machine_id, cwd });

  const token = config.tokens[deps.agentKind];
  if (token) {
    const params = new URLSearchParams();
    if (remote) params.set("repo", remote);
    if (branch) params.set("branch", branch);
    if (cwd) params.set("cwd", cwd);
    params.set("machine_id", config.machine_id);
    params.set("agent_kind", deps.agentKind);

    try {
      const response = await deps.fetch(`${config.api_base_url}/api/v1/me/brief?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const body = (await response.json()) as { text?: string };
        if (typeof body.text === "string" && body.text !== "") return body.text;
      }
      deps.stderr(`37soul hook: brief API answered ${response.status}; using the local cache\n`);
    } catch (error) {
      deps.stderr(`37soul hook: brief API failed (${(error as Error).message}); using the local cache\n`);
    }
  }

  if (!key) return "";
  const cached = await readCache(root, key, branch);
  return cached ?? "";
}

async function fallbackFromCache(deps: HookDeps, cwd: string | null): Promise<string> {
  try {
    const root = dataRoot(deps.home);
    const config = await loadConfig(root);
    if (!config) return "";
    const key = repoKey({ remote: null, machineId: config.machine_id, cwd });
    if (!key) return "";
    return (await readCache(root, key, null)) ?? "";
  } catch {
    return "";
  }
}

async function readCache(root: string, key: string, branch: string | null): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  for (const candidate of [cachePath(root, key, branch), cachePath(root, key, "-")]) {
    try {
      const text = await readFile(candidate, "utf8");
      if (text.trim() !== "") return text;
    } catch {
      // 换下一个
    }
  }
  return null;
}

/** 给整体调用加预算；超时抛错，由调用方落到缓存兜底。 */
function withBudget<T>(ms: number, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hook budget of ${ms}ms exceeded`)), ms);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
