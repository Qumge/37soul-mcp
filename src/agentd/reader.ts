/**
 * 会话文件增量读取（设计 §6.2）。
 *
 * 读进度的语义：
 *   · cursor = { inode, offset, seq }；按**字节** offset 读，只吃完整行；
 *   · 末尾的半行永远不解析、也不推进 offset（下一次写入把行补全再说）；
 *   · 文件被截断或换了 inode → 从头读，seq 继续沿用（同一会话的事件序号绝不回头）；
 *   · 无效 JSON 的行跳过并记一条诊断，不让一行坏数据卡死整个采集。
 */

import { open, stat } from "node:fs/promises";
import type { FileCursor, NormalizedEvent, ParsedEvent, SessionMetadata, TranscriptParser } from "./types.js";

export interface ReadIncrementResult {
  events: NormalizedEvent[];
  metadata: Partial<SessionMetadata>;
  nextCursor: FileCursor;
  diagnostics: string[];
  /** 这次读发生了截断/换 inode，从头读的 */
  restarted: boolean;
}

export interface ReadIncrementOptions {
  parser: TranscriptParser;
  /** 单次最多读的字节数（daemon 循环读到追上为止）；默认 8MB。 */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export async function readIncrement(
  file: string,
  cursor: FileCursor | null,
  opts: ReadIncrementOptions,
): Promise<ReadIncrementResult> {
  const info = await stat(file);
  const inode = Number(info.ino);

  let offset = cursor?.offset ?? 0;
  let seq = cursor?.seq ?? 0;
  let restarted = false;

  if (cursor && (cursor.inode !== inode || info.size < cursor.offset)) {
    offset = 0;
    restarted = true;
  }

  const events: NormalizedEvent[] = [];
  const diagnostics: string[] = [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const toRead = Math.max(0, Math.min(info.size - offset, maxBytes));
  let nextOffset = offset;

  if (toRead > 0) {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
      const chunk = buffer.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);

      if (lastNewline >= 0) {
        const complete = chunk.subarray(0, lastNewline + 1).toString("utf8");
        for (const line of complete.split("\n")) {
          if (line.trim() === "") continue;

          let record: unknown;
          try {
            record = JSON.parse(line);
          } catch (error) {
            diagnostics.push(`invalid JSON line skipped (${(error as Error).message})`);
            continue;
          }
          for (const event of opts.parser.push(record)) {
            seq += 1;
            events.push({ ...(event as ParsedEvent), seq });
          }
        }
        // 半行（lastNewline 之后的字节）留给下一次：offset 只推进到最后一个换行。
        nextOffset = offset + Buffer.byteLength(complete, "utf8");
      }
    } finally {
      await handle.close();
    }
  }

  return {
    events,
    metadata: opts.parser.metadata(),
    nextCursor: { inode, offset: nextOffset, seq },
    diagnostics,
    restarted,
  };
}
