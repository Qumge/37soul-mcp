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

import path from "node:path";
import type { GitStateResult } from "./agentd/git-state.js";
import { getGitState } from "./agentd/git-state.js";
import { appendSpoolRecord } from "./agentd/spool.js";
import { dataRoot } from "./install.js";
import { cachePath } from "./agentd/brief-cache.js";
import { loadConfig, loadState } from "./agentd/state.js";
import { repoKey } from "./repo-key.js";

export interface HookDeps {
  home: string;
  agentKind: string;
  fetch: typeof fetch;
  stdin: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  getGitState?: (cwd: string) => Promise<GitStateResult>;
  /** 整体预算，默认 300ms（设计 §6.3；内部实现留 50ms 收尾余量）。 */
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
  // ⚠️ 预算是「hook 让启动变慢不超过 300ms」的整体耗时：API 250ms 放弃后还要
  // 读缓存并打印，250 + 收尾 < 300。brief 的 P95 只有 ~14ms，真实请求用不到上限。
  const timeoutMs = deps.timeoutMs ?? 250;

  let payload: HookPayload & { session_id?: string };
  try {
    payload = JSON.parse(deps.stdin) as HookPayload & { session_id?: string };
  } catch {
    deps.stderr("37soul hook: stdin was not valid JSON — skipping injection\n");
    return 0;
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : null;
  const sessionId = typeof payload.session_id === "string" && payload.session_id !== "" ? payload.session_id : null;

  try {
    const text = await withBudget(timeoutMs, () => resolveBrief(deps, cwd, { sessionId, reason: "start" }));
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

async function resolveBrief(
  deps: HookDeps,
  cwd: string | null,
  opts: { sessionId?: string | null; reason?: string } = {},
): Promise<string> {
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
    // v2 §4.2：带 session_id 才执行认领；compact 时不重复认领。
    if (opts.sessionId) params.set("session_id", opts.sessionId);
    if (opts.reason) params.set("reason", opts.reason);

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

// ── v2：`37soul hook --agent <kind> --event <事件名>`（设计 §6.3） ─────────────
//
// 除 SessionStart（以及 UserPromptSubmit 通道的首轮注入）外，必须在 50ms 内退出：
// 只解析载荷、追加一行到 spool，不发网络请求。任何异常吞掉、退出码 0、stdout 为空。

export interface HookCommandDeps extends HookDeps {
  event: string;
  now?: () => number;
}

/** 注入通道（§6.4）：P1 的两个 Agent 都是 SessionStart。 */
const INJECTION_CHANNEL: Record<string, "SessionStart" | "UserPromptSubmit" | "none"> = {
  "claude-code": "SessionStart",
  codex: "SessionStart",
};

export async function runHookCommand(deps: HookCommandDeps): Promise<number> {
  try {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(deps.stdin) as Record<string, any>;
    } catch {
      deps.stderr("37soul hook: stdin was not valid JSON\n");
      return 0;
    }

    const root = dataRoot(deps.home);
    // 暂停时直接退出：不写 spool、不注入（§6.1）。全局暂停看得到；按 repo 的暂停
    // 需要 git 调用，会突破 50ms 预算，交给 agentd 在攒批时丢。
    const state = await loadState(root);
    if (state.paused) return 0;

    const sessionId = String(payload.session_id ?? payload.sessionId ?? payload.thread_id ?? "unknown");
    const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;

    const record = mapHookEvent(deps.event, payload, nowIso, cwd);
    if (record) {
      await appendSpoolRecord(root, deps.agentKind, sessionId, record).catch((error: Error) => {
        deps.stderr(`37soul hook: could not append to spool (${error.message})\n`);
      });
    }

    if (deps.event === "PreCompact") {
      await writeReinjectMarker(root, sessionId).catch(() => {});
      return 0;
    }

    const channel = INJECTION_CHANNEL[deps.agentKind] ?? "none";
    if (deps.event === "SessionStart" && channel === "SessionStart") {
      if (payload.source === "compact") await clearReinjectMarker(root, sessionId).catch(() => {});
      const reason = payload.source === "compact" ? "compact" : "start";
      const startedAt = deps.now?.() ?? Date.now();
      const text = await withBudget(deps.timeoutMs ?? 300, () => resolveBrief(deps, cwd ?? null, { sessionId, reason }));
      void startedAt;
      if (text.trim() !== "") deps.stdout(`${wrapAdditionalContext(text)}\n`);
      return 0;
    }

    if (deps.event === "UserPromptSubmit" && channel === "UserPromptSubmit") {
      if (await reinjectPending(root, sessionId)) {
        try {
          const text = await withBudget(deps.timeoutMs ?? 300, () => resolveBrief(deps, cwd ?? null, { sessionId, reason: "compact" }));
          if (text.trim() !== "") deps.stdout(`${wrapAdditionalContext(text)}\n`);
        } finally {
          await clearReinjectMarker(root, sessionId).catch(() => {});
        }
        return 0;
      }
    }

    return 0; // 其余事件：stdout 必须为空
  } catch (error) {
    deps.stderr(`37soul hook: ${(error as Error).message}\n`);
    return 0;
  }
}

/** hook 事件 → spool 记录（§6.3 的映射表）。返回 null = 这个载荷没有可记的事件。 */
export function mapHookEvent(
  event: string,
  payload: Record<string, any>,
  at: string,
  cwd?: string,
): SpoolHookRecord | null {
  const base = { at, via: "hook" as const, ...(cwd ? { cwd } : {}) };

  switch (event) {
    case "SessionStart":
      return { ...base, kind: "session_start", ...(typeof payload.source === "string" ? { source: payload.source } : {}) };
    case "SessionEnd":
      return { ...base, kind: "session_end" };
    case "PreCompact":
      return { ...base, kind: "compact" };
    case "UserPromptSubmit": {
      const text = firstString(payload.prompt, payload.user_prompt, payload.userPrompt, payload.message, payload.text);
      return text ? { ...base, kind: "message", role: "user", text } : null;
    }
    case "Stop": {
      // v2 §6.3/§6.9：优先取 Stop 载荷里的 last_assistant_message，不必解析会话记录。
      const text = firstString(payload.last_assistant_message, payload.lastAssistantMessage);
      return text ? { ...base, kind: "message", role: "assistant", text } : null;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const name = firstString(payload.tool_name, payload.toolName, payload.name) ?? "tool";
      const input = payload.tool_input ?? payload.toolInput ?? payload.arguments ?? payload.input;
      const output = payload.tool_response ?? payload.toolResponse ?? payload.output;
      const isError = event === "PostToolUseFailure" || payload?.tool_response?.is_error === true || payload?.toolResponse?.is_error === true;
      return {
        ...base,
        kind: "tool",
        role: "tool",
        text: "",
        tool: {
          name,
          input_summary: summarizeHookToolInput(input),
          output_summary: truncateText(stringifyOutput(output), 500),
          is_error: isError,
        },
      };
    }
    default:
      return null;
  }
}

interface SpoolHookRecord {
  at: string;
  kind: "message" | "tool" | "session_start" | "session_end" | "compact";
  via: "hook";
  cwd?: string;
  source?: string;
  role?: "user" | "assistant" | "tool";
  text?: string;
  tool?: { name: string; input_summary: string; output_summary: string; is_error: boolean };
}

function summarizeHookToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncateText(input.trim(), 200);
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "command", "pattern", "url", "query", "description", "target_file"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return truncateText(value.trim(), 200);
    }
    try {
      return truncateText(JSON.stringify(input), 200);
    } catch {
      return "";
    }
  }
  return String(input).slice(0, 200);
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    for (const key of ["stdout", "output", "text", "content", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
    try {
      return JSON.stringify(output);
    } catch {
      return "";
    }
  }
  return String(output);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// PreCompact 的「待重新注入」标记（§6.3）：压缩后不会触发 SessionStart 的 Agent，
// 在 PreCompact 之后第一次 UserPromptSubmit 注入并清掉。
function markerPath(root: string, sessionId: string): string {
  return path.join(root, "state", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

async function writeReinjectMarker(root: string, sessionId: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(root, "state"), { recursive: true, mode: 0o700 });
  await writeFile(markerPath(root, sessionId), `${JSON.stringify({ needs_reinject: true, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

async function reinjectPending(root: string, sessionId: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  try {
    const parsed = JSON.parse(await readFile(markerPath(root, sessionId), "utf8")) as { needs_reinject?: boolean };
    return parsed.needs_reinject === true;
  } catch {
    return false;
  }
}

async function clearReinjectMarker(root: string, sessionId: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(markerPath(root, sessionId), { force: true });
}
