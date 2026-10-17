/**
 * Claude Code 原生会话 JSONL 的解析器（实测回填见设计 §6.4.1）。
 *
 * 每条记录已经在 reader 里被 JSON.parse 成**完整对象**（半行永远不喂进来）。
 * 这里做三件事：
 *   1. 只认 user / assistant 两类消息；其余元数据类型（mode、last-prompt、
 *      attachment、file-history-*、cost-state……）一律跳过；
 *   2. `isSidechain` 的子代理记录、`isMeta` 的注入/本地命令记录跳过；
 *   3. 工具调用等它的结果到了才吐事件（call → result 配对），没等到结果的调用
 *      在 `flush()` 时以“无结果”落地。
 */

import type { ParsedEvent, SessionMetadata, TranscriptParser } from "../types.js";

const SKIP_TYPES = new Set([
  "system",
  "last-prompt",
  "mode",
  "permission-mode",
  "atis-latch",
  "ai-title",
  "queue-operation",
  "file-history-snapshot",
  "file-history-delta",
  "cost-state",
]);

const SUMMARY_KEYS = ["file_path", "command", "pattern", "path", "url", "query", "prompt", "description"];

export const MAX_EVENT_TEXT = 8000;
export const MAX_TOOL_SUMMARY = 500;

export function createClaudeCodeParser(opts: { externalId?: string } = {}): TranscriptParser {
  const pendingCalls = new Map<string, { name: string; input_summary: string; at: string }>();
  const meta: SessionMetadata = { external_id: opts.externalId ?? "" };
  let nativeExternalId = false;
  let sawEnd = false;

  function push(record: unknown): ParsedEvent[] {
    if (!record || typeof record !== "object") return [];
    const r = record as Record<string, any>;

    absorbMetadata(r);
    if (r.isSidechain === true || r.attachment || SKIP_TYPES.has(r.type)) return [];

    if (r.type === "user") return userEvents(r);
    if (r.type === "assistant") return assistantEvents(r);
    return [];
  }

  function absorbMetadata(r: Record<string, any>): void {
    // 原生 sessionId 优先于文件名字回退：安装目录改名了也不该换身份。
    if (!nativeExternalId && typeof r.sessionId === "string" && r.sessionId) {
      meta.external_id = r.sessionId;
      nativeExternalId = true;
    }
    if (typeof r.cwd === "string" && r.cwd) meta.cwd = r.cwd;
    if (typeof r.gitBranch === "string" && r.gitBranch.trim()) meta.branch = r.gitBranch.trim();
    if (!meta.started_at && typeof r.timestamp === "string" && !Number.isNaN(Date.parse(r.timestamp))) {
      meta.started_at = r.timestamp;
    }
  }

  function userEvents(r: Record<string, any>): ParsedEvent[] {
    if (r.isMeta === true) return [];
    const content = r.message?.content;
    const at = typeof r.timestamp === "string" ? r.timestamp : undefined;

    if (typeof content === "string") {
      const text = content.trim();
      return text ? [textEvent("user", content, at)] : [];
    }

    if (Array.isArray(content)) {
      const results = content.filter((b: any) => b?.type === "tool_result");
      if (results.length > 0) return results.flatMap((b: any) => toolResultEvents(b, at));

      const text = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return text ? [textEvent("user", text, at)] : [];
    }
    return [];
  }

  function assistantEvents(r: Record<string, any>): ParsedEvent[] {
    const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
    const at = typeof r.timestamp === "string" ? r.timestamp : undefined;
    const out: ParsedEvent[] = [];

    const text = blocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("")
      .trim();
    if (text) out.push(textEvent("assistant", text, at));

    for (const block of blocks) {
      if (block?.type !== "tool_use") continue;
      const name = typeof block.name === "string" && block.name ? block.name : "tool";
      const summary = summarizeToolInput(block.input);
      const callId = typeof block.id === "string" ? block.id : undefined;
      if (callId) {
        pendingCalls.set(callId, { name, input_summary: summary, at: at ?? nowIso() });
      } else {
        out.push(toolEvent(name, summary, "", false, at));
      }
    }
    return out;
  }

  function toolResultEvents(block: Record<string, any>, at?: string): ParsedEvent[] {
    const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const pending = callId ? pendingCalls.get(callId) : undefined;
    if (callId) pendingCalls.delete(callId);

    const name = pending?.name ?? "tool";
    const input = pending?.input_summary ?? "";
    const output = contentText(block.content);
    const isError = block.is_error === true;
    return [toolEvent(name, input, output, isError, at ?? pending?.at)];
  }

  function flush(): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    for (const call of pendingCalls.values()) {
      out.push(toolEvent(call.name, call.input_summary, "", false, call.at));
    }
    pendingCalls.clear();
    return out;
  }

  return {
    push,
    flush,
    metadata: () => ({ ...meta }),
    ended: () => sawEnd,
  };
}

export function textEvent(role: "user" | "assistant", text: string, at?: string): ParsedEvent {
  return { role, text: truncate(text, MAX_EVENT_TEXT), at: isoOrNow(at) };
}

export function toolEvent(
  name: string,
  inputSummary: string,
  outputSummary: string,
  isError: boolean,
  at?: string,
): ParsedEvent {
  return {
    role: "tool",
    text: "",
    at: isoOrNow(at),
    tool: {
      name: truncate(name, 200),
      input_summary: truncate(inputSummary ?? "", MAX_TOOL_SUMMARY),
      output_summary: truncate(outputSummary ?? "", MAX_TOOL_SUMMARY),
      is_error: isError === true,
    },
  };
}

/** tool_use.input 里最像「他在干什么」的那个字段；都没有就存 JSON 摘要。 */
export function summarizeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input.trim(), 200);
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of SUMMARY_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return truncate(value.trim(), 200);
    }
    try {
      return truncate(JSON.stringify(input), 200);
    } catch {
      return "";
    }
  }
  return String(input).slice(0, 200);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
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
  return nowIso();
}

function nowIso(): string {
  return new Date().toISOString();
}
