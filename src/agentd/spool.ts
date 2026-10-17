/**
 * 本地 spool（v2 §6.2/§6.3）：hook 把每个事件追加成一行 JSON，agentd 读它、
 * 分配 seq、攒批上传。hook 侧只做「解析 + 追加」，不联网、不发请求。
 *
 * 事件是统一格式的「无 seq」版本：`{ at, kind, via, role?, text?, tool?, cwd? }`。
 * seq 由 reader 按会话文件分配（与兜底解析器共用同一套逻辑）。
 */

import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { EventKind, ParsedEvent, SessionMetadata, ToolInfo, TranscriptParser } from "./types.js";
import { MAX_EVENT_TEXT, MAX_TOOL_SUMMARY } from "./parsers/claude-code.js";

export const SPOOL_MAX_BYTES = 50 * 1024 * 1024;

export interface SpoolRecord {
  at: string;
  kind: EventKind;
  via?: "hook";
  role?: "user" | "assistant" | "tool";
  text?: string;
  tool?: ToolInfo;
  cwd?: string;
  /** SessionStart 载荷的 source（startup / resume / clear / compact）。 */
  source?: string;
}

const MARKER_KINDS = new Set<EventKind>(["session_start", "session_end", "compact"]);
const KINDS = new Set<EventKind>(["message", "tool", "session_start", "session_end", "compact"]);

export function spoolRoot(root: string): string {
  return path.join(root, "spool");
}

export function spoolDir(root: string, agentKind: string): string {
  return path.join(spoolRoot(root), agentKind);
}

export function spoolFile(root: string, agentKind: string, sessionId: string): string {
  const safe = (sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(spoolDir(root, agentKind), `${safe}.jsonl`);
}

export async function appendSpoolRecord(
  root: string,
  agentKind: string,
  sessionId: string,
  record: SpoolRecord,
): Promise<void> {
  await mkdir(spoolDir(root, agentKind), { recursive: true, mode: 0o700 });
  await appendFile(spoolFile(root, agentKind, sessionId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** 列出一个 Agent 的 spool 会话文件。 */
export async function spoolFiles(root: string, agentKind: string): Promise<string[]> {
  try {
    const entries = (await readdir(spoolDir(root, agentKind))) as string[];
    return entries.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(spoolDir(root, agentKind), name));
  } catch {
    return [];
  }
}

/** doctor / 诊断用：spool 的总量和每个 Agent 的最后写入时间。 */
export async function spoolStats(root: string): Promise<{
  bytes: number;
  agents: Record<string, { bytes: number; lastModifiedMs: number; sessions: number }>;
}> {
  const result: { bytes: number; agents: Record<string, { bytes: number; lastModifiedMs: number; sessions: number }> } = {
    bytes: 0,
    agents: {},
  };
  let agentDirs: string[] = [];
  try {
    agentDirs = (await readdir(spoolRoot(root), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return result;
  }

  for (const agentKind of agentDirs) {
    const stats = { bytes: 0, lastModifiedMs: 0, sessions: 0 };
    for (const file of await spoolFiles(root, agentKind)) {
      try {
        const info = await stat(file);
        stats.bytes += info.size;
        stats.lastModifiedMs = Math.max(stats.lastModifiedMs, info.mtimeMs);
        stats.sessions += 1;
      } catch {
        // 并发轮转/删除：忽略
      }
    }
    result.agents[agentKind] = stats;
    result.bytes += stats.bytes;
  }
  return result;
}

/** v2 §6.2：spool 总量超过 50MB 时丢弃最早的文件（记一条诊断，绝不静默）。 */
export async function trimSpool(
  root: string,
  maxBytes = SPOOL_MAX_BYTES,
  log?: { error: (message: string) => void },
): Promise<string[]> {
  const evicted: string[] = [];
  let files: Array<{ file: string; size: number; mtimeMs: number }> = [];
  try {
    const agentDirs = (await readdir(spoolRoot(root), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const agentKind of agentDirs) {
      for (const file of await spoolFiles(root, agentKind)) {
        const info = await stat(file);
        files.push({ file, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  } catch {
    return evicted;
  }

  let total = files.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxBytes) return evicted;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of files) {
    if (total <= maxBytes) break;
    await rm(entry.file, { force: true });
    total -= entry.size;
    evicted.push(entry.file);
    log?.error(`spool over ${maxBytes} bytes: evicted oldest session file ${entry.file}`);
  }
  return evicted;
}

/**
 * 把 spool 的一行记录转成统一事件。解析器接口和兜底解析器完全一致，reader
 * 不用区分来源。
 */
export function createSpoolParser(opts: { externalId?: string } = {}): TranscriptParser {
  const meta: SessionMetadata = { external_id: opts.externalId ?? "" };

  return {
    push(record: unknown): ParsedEvent[] {
      if (!record || typeof record !== "object") return [];
      const r = record as Record<string, any>;

      if (typeof r.cwd === "string" && r.cwd) meta.cwd = r.cwd;
      if (!meta.started_at && typeof r.at === "string" && !Number.isNaN(Date.parse(r.at))) meta.started_at = r.at;

      const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
      const kind: EventKind = KINDS.has(r.kind) ? r.kind : r.tool ? "tool" : "message";

      if (MARKER_KINDS.has(kind)) {
        return [{ at, kind, via: "hook" }];
      }

      const event: ParsedEvent = {
        at,
        kind,
        via: "hook",
        role: r.role === "user" || r.role === "assistant" || r.role === "tool" ? r.role : kind === "tool" ? "tool" : "assistant",
        text: typeof r.text === "string" ? r.text.slice(0, MAX_EVENT_TEXT) : "",
      };
      if (r.tool && typeof r.tool === "object") {
        event.tool = {
          name: String(r.tool.name ?? "tool").slice(0, 200),
          input_summary: String(r.tool.input_summary ?? "").slice(0, MAX_TOOL_SUMMARY),
          output_summary: String(r.tool.output_summary ?? "").slice(0, MAX_TOOL_SUMMARY),
          is_error: r.tool.is_error === true,
        };
      }
      return [event];
    },
    flush: () => [],
    metadata: () => ({ ...meta }),
    ended: () => false,
  };
}
