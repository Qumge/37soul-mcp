/**
 * Codex CLI rollout JSONL 的解析器（实测回填见设计 §6.4.1；Codex 0.162.1）。
 *
 * 记录形状：
 *   · `session_meta`      → 会话 id / 初始 cwd / 开始时间
 *   · `turn_context`      → 每次 turn 的 cwd（会变，取最新）
 *   · `response_item.message`          role=user/assistant 的输入/输出文本
 *   · `response_item.custom_tool_call` / `function_call`        → 调用
 *   · `response_item.custom_tool_call_output` / `..._output`    → 结果（call_id 关联）
 *   其余（reasoning / compaction / world_state / event_msg / token_usage_record…）跳过。
 *
 * 工具调用和结果配对后才吐 tool 事件；`Script failed` 开头的结果是错误（实测，
 * 成功是 `Script completed`）。
 */

import type { ParsedEvent, SessionMetadata, TranscriptParser } from "../types.js";
import { MAX_EVENT_TEXT, MAX_TOOL_SUMMARY, toolEvent } from "./claude-code.js";

const INJECTED_CONTEXT = /^\s*<(environment_context|permissions instructions|user_instructions|workspace_context)\b/;
const CMD_IN_SCRIPT = /cmd\s*:\s*"((?:[^"\\]|\\.)*)"/;
const PATCH_TARGET = /^\*{3}\s(?:Update|Add|Delete) File:\s*(.+)$/m;
const SUMMARY_ARG_KEYS = ["cmd", "command", "file_path", "path", "query", "description"];

export function createCodexParser(opts: { externalId?: string } = {}): TranscriptParser {
  const pendingCalls = new Map<string, { name: string; input_summary: string; at: string; status?: string }>();
  const meta: SessionMetadata = { external_id: opts.externalId ?? "" };
  let nativeExternalId = false;

  function push(record: unknown): ParsedEvent[] {
    if (!record || typeof record !== "object") return [];
    const r = record as Record<string, any>;

    if (r.type === "session_meta") {
      if (!nativeExternalId && typeof r.payload?.id === "string" && r.payload.id) {
        meta.external_id = r.payload.id;
        nativeExternalId = true;
      }
      if (typeof r.payload?.cwd === "string" && r.payload.cwd) meta.cwd = r.payload.cwd;
      if (!meta.started_at && typeof r.timestamp === "string" && !Number.isNaN(Date.parse(r.timestamp))) {
        meta.started_at = r.timestamp;
      }
      return [];
    }

    if (r.type === "turn_context") {
      if (typeof r.payload?.cwd === "string" && r.payload.cwd) meta.cwd = r.payload.cwd;
      return [];
    }

    if (r.type !== "response_item") return [];
    const p = r.payload;
    if (!p || typeof p !== "object") return [];
    const at = typeof r.timestamp === "string" ? r.timestamp : undefined;

    switch (p.type) {
      case "message":
        return messageEvents(p, at);
      case "custom_tool_call":
      case "function_call":
        rememberCall(p, at);
        return [];
      case "custom_tool_call_output":
      case "function_call_output":
        return outputEvents(p, at);
      default:
        return [];
    }
  }

  function messageEvents(p: Record<string, any>, at?: string): ParsedEvent[] {
    if (p.role !== "user" && p.role !== "assistant") return [];
    const key = p.role === "user" ? "input_text" : "output_text";
    const text = (Array.isArray(p.content) ? p.content : [])
      .filter((b: any) => b?.type === key && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (!text) return [];
    if (p.role === "user" && INJECTED_CONTEXT.test(text)) return [];
    return [{ role: p.role, text: truncate(text, MAX_EVENT_TEXT), at: isoOrNow(at) }];
  }

  function rememberCall(p: Record<string, any>, at?: string): void {
    const callId = typeof p.call_id === "string" ? p.call_id : undefined;
    const name = typeof p.name === "string" && p.name ? p.name : p.type === "custom_tool_call" ? "exec" : "tool";
    const summary = p.type === "custom_tool_call" ? summarizeExecScript(p.input) : summarizeFunctionArguments(p.arguments);
    const entry = { name, input_summary: summary, at: isoOrNow(at), status: typeof p.status === "string" ? p.status : undefined };
    if (callId) pendingCalls.set(callId, entry);
    else pendingCalls.set(`anon-${pendingCalls.size}`, entry);
  }

  function outputEvents(p: Record<string, any>, at?: string): ParsedEvent[] {
    const callId = typeof p.call_id === "string" ? p.call_id : undefined;
    const pending = callId ? pendingCalls.get(callId) : undefined;
    if (callId) pendingCalls.delete(callId);

    const text = outputText(p.output);
    const failedByStatus = pending?.status === "failed" || pending?.status === "errored";
    const isError = failedByStatus || /^\s*Script failed\b/.test(text);
    return [toolEvent(pending?.name ?? "tool", pending?.input_summary ?? "", text, isError, at ?? pending?.at)];
  }

  function flush(): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    for (const call of pendingCalls.values()) {
      out.push(toolEvent(call.name, call.input_summary, "", call.status === "failed", call.at));
    }
    pendingCalls.clear();
    return out;
  }

  return {
    push,
    flush,
    metadata: () => ({ ...meta }),
    // Codex 的 rollout 没有显式结束标记；结束由 agentd 的空闲窗口判断。
    ended: () => false,
  };
}

/** exec 脚本里的 `cmd:"..."` 就是「他在跑什么」；没有就存脚本开头。 */
export function summarizeExecScript(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") return "";
  const match = CMD_IN_SCRIPT.exec(input);
  if (match) {
    try {
      return truncate(JSON.parse(`"${match[1]}"`) as string, 200);
    } catch {
      return truncate(match[1], 200);
    }
  }
  return truncate(input.trim(), 200);
}

/** function_call 的 arguments 是 JSON 字符串；挑有代表性的字段。 */
export function summarizeFunctionArguments(argumentsText: unknown): string {
  if (typeof argumentsText !== "string" || argumentsText.trim() === "") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return truncate(argumentsText.trim(), 200);
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of SUMMARY_ARG_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return truncate(value.trim(), 200);
    }
    if (typeof record.patch === "string") {
      const target = PATCH_TARGET.exec(record.patch);
      return truncate((target?.[1] ?? record.patch).trim(), 200);
    }
    try {
      return truncate(JSON.stringify(parsed), 200);
    } catch {
      return "";
    }
  }
  return truncate(String(parsed), 200);
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as any).text === "string") return (part as any).text;
        return "";
      })
      .join("\n");
  }
  return "";
}

function truncate(text: string, max: number): string {
  const value = text ?? "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isoOrNow(at?: string): string {
  if (typeof at === "string" && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString();
  return new Date().toISOString();
}

export { MAX_TOOL_SUMMARY };
