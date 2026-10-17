/**
 * 本地采集与上传的统一协议类型（设计 2026-10-17 §5.1）。
 *
 * 服务端只认这一种事件格式；各 Agent 的原生 JSONL 在 agentd 里转换。字段名与
 * 服务端 `TranscriptIngestor` / `TranscriptEventValidator` 一一对应，改名就是
 * 破坏协议。
 */

export type IngestibleAgentKind = "claude-code" | "codex" | "pi" | "gemini-cli";

export type EventRole = "user" | "assistant" | "tool";

/** v2 §5.1：事件种类。缺省时按内容推断（有 tool → tool，否则 message）。 */
export type EventKind = "message" | "tool" | "session_start" | "session_end" | "compact";

/** v2 §5.1：事件来源。hook 为主，transcript 是会话记录兜底。 */
export type EventVia = "hook" | "transcript";

export interface ToolInfo {
  name: string;
  input_summary: string;
  output_summary: string;
  is_error: boolean;
}

export interface NormalizedEvent {
  /** 从 1 连续递增，由 reader 按会话分配（parser 不负责编号）。 */
  seq: number;
  /** ISO8601 UTC。 */
  at: string;
  /** v2：session_start / session_end / compact 只有 seq/at/kind/via。 */
  kind?: EventKind;
  via?: EventVia;
  role?: EventRole;
  text?: string;
  tool?: ToolInfo;
  /** v1 兼容字段（旧会话记录里的结束标记）。新事件一律用 kind。 */
  event_type?: "session_end";
}

/** parser 产出的事件：还没有 seq。 */
export type ParsedEvent = Omit<NormalizedEvent, "seq">;

export interface SessionMetadata {
  /** Agent 自己的会话 id（Claude Code 的 jsonl 文件名、Codex 的 rollout id）。 */
  external_id: string;
  cwd?: string;
  started_at?: string;
  /** 原生格式里看到的分支（Claude Code 的 gitBranch；Codex 由 git 命令采）。 */
  branch?: string;
}

export interface Diffstat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface GitState {
  branch?: string;
  head?: string;
  head_subject?: string;
  dirty_files?: string[];
  diffstat?: Partial<Diffstat>;
  ahead?: number;
  behind?: number;
}

export interface TranscriptUpload {
  agent_kind: IngestibleAgentKind;
  machine_id: string;
  session: SessionMetadata;
  repo?: { remote?: string; branch?: string };
  seq_from: number;
  seq_to: number;
  events: NormalizedEvent[];
  git_state?: GitState;
}

/** GET /api/v1/me/brief 与 MCP resume 的返回。 */
export interface BriefResponse {
  text: string;
  etag: string;
  workspace_id: number | null;
  checkpoint_version: number | null;
}

/** 本地读取进度：inode + offset + 已分配的 seq。 */
export interface FileCursor {
  inode: number;
  offset: number;
  seq: number;
}

export interface ParserOutcome {
  events: ParsedEvent[];
  metadata: Partial<SessionMetadata>;
  ended: boolean;
}

/** 每个 Agent 的解析器：喂**完整的一行**原生 JSON 对象，吐规范化事件。 */
export interface TranscriptParser {
  /**
   * @param record 已经从 JSONL 解析出来的完整原生对象
   * @returns 该记录产生的事件（可能为空；工具事件在结果到达时才吐，见 parsers）
   */
  push(record: unknown): ParsedEvent[];
  /** 文件读到 EOF：把还挂着的工具调用以“没有结果”收尾。 */
  flush(): ParsedEvent[];
  /** 到目前为止的会话元数据。 */
  metadata(): SessionMetadata;
  /** 原生格式里出现了会话结束标记（Claude 目前没有；Agent 自带标记时用）。 */
  ended(): boolean;
}
