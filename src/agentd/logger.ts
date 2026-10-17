/**
 * agentd 的日志：滚动 5MB × 3，且**绝不写 bearer token**。
 *
 * 上传的鉴权头是 `Authorization: Bearer <PAT>` —— 日志只记 URL 和状态码，
 * 不记 headers。这条由 uploader 的实现方式保证（根本不往 logger 递 headers），
 * 测试再兜一层。
 */

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface LoggerOptions {
  file: string;
  maxBytes?: number;
  keep?: number;
}

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 3;

export interface RotatingLogger {
  info(message: string): void;
  error(message: string): void;
  logPath(): string;
  flush(): Promise<void>;
}

export function createRotatingLogger(opts: LoggerOptions): RotatingLogger {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = opts.keep ?? DEFAULT_KEEP;
  let chain: Promise<void> = Promise.resolve();

  function write(level: string, message: string): void {
    chain = chain.then(async () => {
      await mkdir(path.dirname(opts.file), { recursive: true, mode: 0o700 });
      await rotateIfNeeded();
      const line = `${new Date().toISOString()} ${level} ${message}\n`;
      await appendFile(opts.file, line, { mode: 0o600 });
    });
  }

  async function rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      size = (await stat(opts.file)).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;

    // agentd.log → agentd.log.1 → … 超出 keep 的删掉。
    for (let index = keep - 1; index >= 1; index -= 1) {
      try {
        await rename(`${opts.file}.${index}`, `${opts.file}.${index + 1}`);
      } catch {
        // 该档不存在
      }
    }
    try {
      await rename(opts.file, `${opts.file}.1`);
    } catch {
      // 并发轮转：忽略
    }
    await rm(`${opts.file}.${keep + 1}`, { force: true });
  }

  return {
    info: (message) => write("INFO", message),
    error: (message) => write("ERROR", message),
    logPath: () => opts.file,
    flush: () => chain,
  };
}
