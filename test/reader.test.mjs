#!/usr/bin/env node
/**
 * 增量读取的边界：半行、坏行、截断、换 inode、同一 offset 重放、空闲后追加。
 * 用真实的临时文件，不 mock fs。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readIncrement } from "../dist/agentd/reader.js";
import { createClaudeCodeParser } from "../dist/agentd/parsers/claude-code.js";

function tempFile(name = "session.jsonl") {
  const dir = mkdtempSync(path.join(tmpdir(), "agentd-reader-"));
  return { dir, file: path.join(dir, name) };
}

function userRecord(text, at, extra = {}) {
  return JSON.stringify({
    type: "user",
    timestamp: at,
    origin: { kind: "human" },
    message: { role: "user", content: text },
    ...extra,
  });
}

test("reader: emits only complete lines and never advances past a partial one", async () => {
  const { file } = tempFile();
  const firstLine = userRecord("第一句", "2026-10-17T04:00:00.000Z");
  const secondLine = userRecord("第二句", "2026-10-17T04:00:01.000Z");
  const partial = userRecord("半行", "2026-10-17T04:00:02.000Z").slice(0, 30);
  writeFileSync(file, `${firstLine}\n${secondLine}\n${partial}`);

  const reader = { parser: createClaudeCodeParser() };
  const first = await readIncrement(file, null, reader);

  assert.deepEqual(first.events.map((e) => [e.seq, e.text]), [[1, "第一句"], [2, "第二句"]]);
  assert.equal(first.nextCursor.offset, Buffer.byteLength(`${firstLine}\n${secondLine}\n`));

  // 文件继续写，把半行补全；从 cursor 继续读到完整事件。
  appendFileSync(file, `${partialRest(partial)}\n`);
  const second = await readIncrement(file, first.nextCursor, reader);

  assert.deepEqual(second.events.map((e) => [e.seq, e.text]), [[3, "半行"]]);
});

function partialRest(partial) {
  // 半行剩下的部分：把原行写全的尾巴。测试里直接重算完整行再切片。
  return userRecord("半行", "2026-10-17T04:00:02.000Z").slice(partial.length);
}

test("reader: an invalid JSON line is skipped with a diagnostic, later lines still parse", async () => {
  const { file } = tempFile();
  writeFileSync(
    file,
    `${userRecord("ok-1", "2026-10-17T04:01:00.000Z")}\n{not-json}\n${userRecord("ok-2", "2026-10-17T04:01:01.000Z")}\n`,
  );

  const result = await readIncrement(file, null, { parser: createClaudeCodeParser() });

  assert.deepEqual(result.events.map((e) => e.text), ["ok-1", "ok-2"]);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], /invalid JSON/);
});

test("reader: truncation restarts at byte 0 but keeps the sequence going", async () => {
  const { file } = tempFile();
  writeFileSync(file, `${userRecord("老一", "2026-10-17T04:02:00.000Z")}\n${userRecord("老二", "2026-10-17T04:02:01.000Z")}\n`);
  const reader = { parser: createClaudeCodeParser() };
  const first = await readIncrement(file, null, reader);
  assert.deepEqual(first.events.map((e) => e.seq), [1, 2]);

  truncateSync(file, 0);
  writeFileSync(file, `${userRecord("新一", "2026-10-17T04:03:00.000Z")}\n`);
  const second = await readIncrement(file, first.nextCursor, reader);

  assert.equal(second.restarted, true);
  assert.deepEqual(second.events.map((e) => [e.seq, e.text]), [[3, "新一"]]); // seq 绝不回头
});

test("reader: a replaced inode restarts too", async () => {
  const { dir, file } = tempFile();
  writeFileSync(file, `${userRecord("旧文件", "2026-10-17T04:04:00.000Z")}\n`);
  const reader = { parser: createClaudeCodeParser() };
  const first = await readIncrement(file, null, reader);
  assert.equal(first.events.length, 1);

  renameSync(file, `${file}.old`);
  writeFileSync(file, `${userRecord("换了 inode", "2026-10-17T04:05:00.000Z")}\n`);
  const second = await readIncrement(file, first.nextCursor, reader);

  assert.equal(second.restarted, true);
  assert.deepEqual(second.events.map((e) => [e.seq, e.text]), [[2, "换了 inode"]]);
  rmSync(dir, { recursive: true, force: true });
});

test("reader: replaying the same cursor yields the same events with the same seq (same offset restart)", async () => {
  const { file } = tempFile();
  writeFileSync(file, `${userRecord("重放", "2026-10-17T04:06:00.000Z")}\n`);
  const reader = { parser: createClaudeCodeParser() };
  const cursor = { inode: statSync(file).ino, offset: 0, seq: 0 };

  const first = await readIncrement(file, cursor, reader);
  const second = await readIncrement(file, cursor, reader);

  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.nextCursor, second.nextCursor);
});

test("reader: appending after an idle end keeps emitting with continuing seq", async () => {
  const { file } = tempFile();
  writeFileSync(file, `${userRecord("收工", "2026-10-17T04:07:00.000Z")}\n`);
  const reader = { parser: createClaudeCodeParser() };
  const first = await readIncrement(file, null, reader);
  assert.equal(first.nextCursor.seq, 1);

  appendFileSync(file, `${userRecord("又回来了", "2026-10-17T04:30:00.000Z")}\n`);
  const second = await readIncrement(file, first.nextCursor, reader);

  assert.deepEqual(second.events.map((e) => [e.seq, e.text]), [[2, "又回来了"]]);
});
