/**
 * 上传协议的大小/形状约束（服务端 TranscriptIngestor / TranscriptEventValidator
 * 的镜像）。agentd 在上传前自查一遍：本地就挡住的话，服务端只会回 413/422，
 * 而 413/422 意味着客户端拆批逻辑有 bug，别让它变成线上重试风暴。
 */

import type { NormalizedEvent } from "./types.js";

export const LIMITS = {
  /** 每批最多事件数（服务端 TranscriptIngestor::MAX_EVENTS）。 */
  maxEventsPerBatch: 200,
  /** 每批最多字节数（整个请求 body 的 JSON 字节）。 */
  maxBatchBytes: 512 * 1024,
  /** 单条事件 text 上限。 */
  maxEventText: 8000,
  /** tool 摘要上限（超过的服务端会截，客户端也截，省流量）。 */
  maxToolSummary: 500,
  /** 单次会话/目录身份的 dirty_files 上限。 */
  maxDirtyFiles: 50,
} as const;

/** v2 §5.1：服务端认的事件种类与来源。 */
export const EVENT_KINDS = ["message", "tool", "session_start", "session_end", "compact"] as const;
export const EVENT_VIAS = ["hook", "transcript"] as const;
export const MARKER_KINDS = ["session_start", "session_end", "compact"] as const;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 把一串事件按「≤200 条 且 整个请求 ≤512KB」切成批。不拆单条事件：
 * 一条 8000 字的 text 单独一批。
 *
 * @param events 已按 seq 升序、连续编号的事件
 * @param buildPayload 用一批事件和它包含的 envelope 构造完整请求体（用来量字节）
 */
export function batchEvents(
  events: NormalizedEvent[],
  buildPayload: (batch: NormalizedEvent[], seqFrom: number, seqTo: number) => unknown,
): Array<{ events: NormalizedEvent[]; seqFrom: number; seqTo: number }> {
  if (events.length === 0) return [];

  const batches: Array<{ events: NormalizedEvent[]; seqFrom: number; seqTo: number }> = [];
  let current: NormalizedEvent[] = [];

  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      events: current,
      seqFrom: current[0].seq,
      seqTo: current[current.length - 1].seq,
    });
    current = [];
  };

  for (const event of events) {
    if (current.length > 0) {
      const candidate = [...current, event];
      const payload = buildPayload(candidate, candidate[0].seq, candidate[candidate.length - 1].seq);
      const tooMany = candidate.length > LIMITS.maxEventsPerBatch;
      const tooBig = utf8Bytes(JSON.stringify(payload)) > LIMITS.maxBatchBytes;
      if (tooMany || tooBig) flush();
    }
    current.push(event);
  }
  flush();
  return batches;
}

/**
 * 客户端侧的形状/连续性校验。失败抛 ProtocolError —— 调用方（daemon）把它当
 * 「这段别上传、记诊断」处理，而不是重试。
 */
export function validateBatch(events: NormalizedEvent[]): void {
  if (events.length === 0) throw new ProtocolError("empty batch");
  if (events.length > LIMITS.maxEventsPerBatch) {
    throw new ProtocolError(`batch has ${events.length} events (max ${LIMITS.maxEventsPerBatch})`);
  }

  let previous = events[0].seq - 1;
  for (const [index, event] of events.entries()) {
    if (!Number.isInteger(event.seq) || event.seq !== previous + 1) {
      throw new ProtocolError(`event ${index} seq ${event.seq} is not contiguous after ${previous}`);
    }
    previous = event.seq;

    if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) {
      throw new ProtocolError(`event ${event.seq} has an invalid timestamp`);
    }
    if (event.kind !== undefined && !(EVENT_KINDS as readonly string[]).includes(event.kind)) {
      throw new ProtocolError(`event ${event.seq} has an unknown kind ${String(event.kind)}`);
    }
    if (event.via !== undefined && !(EVENT_VIAS as readonly string[]).includes(event.via)) {
      throw new ProtocolError(`event ${event.seq} has an unknown via ${String(event.via)}`);
    }
    // v2 标记事件（只有 seq/at/kind/via）与 v1 的 event_type 结束标记都可以这么收尾。
    if (event.kind !== undefined && (MARKER_KINDS as readonly string[]).includes(event.kind)) continue;
    if (event.event_type === "session_end") continue;

    if (event.role !== "user" && event.role !== "assistant" && event.role !== "tool") {
      throw new ProtocolError(`event ${event.seq} has an invalid role`);
    }
    if (typeof event.text !== "string") {
      throw new ProtocolError(`event ${event.seq} text must be a string`);
    }
    if (event.text.length > LIMITS.maxEventText) {
      throw new ProtocolError(`event ${event.seq} text is longer than ${LIMITS.maxEventText}`);
    }
    if (event.role === "tool") {
      if (!event.tool || typeof event.tool.name !== "string" || event.tool.name === "") {
        throw new ProtocolError(`event ${event.seq} tool event needs a tool name`);
      }
    }
  }
}
