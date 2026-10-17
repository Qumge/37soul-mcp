/**
 * 本地持久上传队列（设计 §6.2）。
 *
 * 契约：**事件先进队列，再推进读取 offset**。进程崩溃、网络断了、token 被吊销，
 * 丢的都只是重试次数，不是会话内容；服务端按 seq 去重，重放是安全的。
 *
 * 一项 = 一个要发往 POST /api/v1/me/transcripts 的批次（≤200 事件、≤512KB）。
 * id 由会话身份 + seq 区间决定：重复入队是幂等的。
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitState, NormalizedEvent, SessionMetadata } from "./types.js";

export interface QueuedUpload {
  id: string;
  sessionKey: string;
  agentKind: string;
  machineId: string;
  externalId: string;
  session: SessionMetadata;
  repo?: { remote?: string; branch?: string };
  seqFrom: number;
  seqTo: number;
  events: NormalizedEvent[];
  gitState?: GitState | null;
  /** v2/审查修复 3：这一批里有 session_end / compact —— 上传成功后要立刻刷新 brief.md。 */
  containsMarkers?: boolean;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

export interface QueueOptions {
  root: string;
  maxBytes?: number;
  now?: () => number;
  log?: { info: (m: string) => void; error: (m: string) => void };
}

export const DEFAULT_QUEUE_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_BACKOFF_MS = 10 * 60 * 1000;

export function uploadId(sessionKey: string, seqFrom: number, seqTo: number): string {
  return `${sessionKey.replace(/[^A-Za-z0-9._-]/g, "_")}__${seqFrom}-${seqTo}`;
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.max(0, attempts));
}

export class UploadQueue {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly log: { info: (m: string) => void; error: (m: string) => void };

  constructor(opts: QueueOptions) {
    this.dir = path.join(opts.root, "queue");
    this.maxBytes = opts.maxBytes ?? DEFAULT_QUEUE_MAX_BYTES;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? { info: () => {}, error: () => {} };
  }

  async enqueue(item: QueuedUpload): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.pathFor(item.id);
    try {
      await stat(target);
      return; // 同一批已经在队列里（watcher + 轮询重复触发）—— 幂等
    } catch {
      // not there yet
    }
    const temp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(temp, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    await rename(temp, target);
    await this.evictIfNeeded();
  }

  async list(): Promise<QueuedUpload[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const items: QueuedUpload[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(this.dir, name), "utf8");
        const parsed = JSON.parse(raw) as QueuedUpload;
        if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.events)) items.push(parsed);
      } catch (error) {
        this.log.error(`queue item unreadable, dropped: ${name} (${(error as Error).message})`);
        await rm(path.join(this.dir, name), { force: true });
      }
    }
    return items.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || a.seqFrom - b.seqFrom);
  }

  /** 一个会话里按 seqFrom 升序 —— 「有顺序地重放」。 */
  async listForSession(sessionKey: string): Promise<QueuedUpload[]> {
    const items = await this.list();
    return items.filter((item) => item.sessionKey === sessionKey).sort((a, b) => a.seqFrom - b.seqFrom);
  }

  async remove(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  async markAttempt(id: string, error: string): Promise<QueuedUpload | null> {
    const items = await this.list();
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return null;
    item.attempts += 1;
    item.lastError = error;
    item.nextAttemptAt = this.now() + backoffMs(item.attempts - 1);
    await this.write(item);
    return item;
  }

  /** 让一项立刻可发（409 补洞时把更早的批次提前）。 */
  async scheduleNow(id: string): Promise<void> {
    const items = await this.list();
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    item.nextAttemptAt = this.now();
    await this.write(item);
  }

  /** 413：把一项拆成两项写回队列（调用方先 remove 原项，或直接覆盖）。 */
  async replace(item: QueuedUpload, parts: QueuedUpload[]): Promise<void> {
    await this.remove(item.id);
    for (const part of parts) await this.enqueue(part);
  }

  async totalBytes(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        total += (await stat(path.join(this.dir, name))).size;
      } catch {
        // 跟丢的并发删除无所谓
      }
    }
    return total;
  }

  /** 队列满 50MB：丢最早的（按 createdAt），并把丢弃记成诊断——绝不静默。 */
  async evictIfNeeded(): Promise<string[]> {
    const evicted: string[] = [];
    let total = await this.totalBytes();
    if (total <= this.maxBytes) return evicted;

    const items = (await this.list()).sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      if (total <= this.maxBytes) break;
      let size = 0;
      try {
        size = (await stat(this.pathFor(item.id))).size;
      } catch {
        continue;
      }
      await this.remove(item.id);
      total -= size;
      evicted.push(item.id);
      this.log.error(`queue over ${this.maxBytes} bytes: evicted oldest upload ${item.id} (session ${item.sessionKey} seq ${item.seqFrom}-${item.seqTo})`);
    }
    return evicted;
  }

  private pathFor(id: string): string {
    // id 由调用方给（daemon 用 uploadId），这里再兜一层：文件名只允许安全字符。
    return path.join(this.dir, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private async write(item: QueuedUpload): Promise<void> {
    const target = this.pathFor(item.id);
    const temp = `${target}.tmp-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }
}

/** 把一项按事件劈成两半（413 拆分用）；单事件项劈不动就原样返回。 */
export function splitUpload(item: QueuedUpload): QueuedUpload[] {
  if (item.events.length < 2) return [item];

  const middle = Math.ceil(item.events.length / 2);
  const halves: Array<[NormalizedEvent[], number, number]> = [
    [item.events.slice(0, middle), item.events[0].seq, item.events[middle - 1].seq],
    [item.events.slice(middle), item.events[middle].seq, item.events[item.events.length - 1].seq],
  ];

  return halves.map(([events, seqFrom, seqTo]) => ({
    ...item,
    id: uploadId(item.sessionKey, seqFrom, seqTo),
    seqFrom,
    seqTo,
    events,
    attempts: 0,
    nextAttemptAt: item.nextAttemptAt,
    containsMarkers: events.some((event) => event.kind === "session_end" || event.kind === "compact" || event.event_type === "session_end"),
    lastError: `split after 413 (${item.seqFrom}-${item.seqTo})`,
  }));
}
