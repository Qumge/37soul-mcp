#!/usr/bin/env node
/**
 * 本地队列：幂等入队、顺序、退避上限、50MB 淘汰、413 拆分。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { UploadQueue, backoffMs, splitUpload, uploadId, MAX_BACKOFF_MS } from "../dist/agentd/queue.js";

function item(overrides = {}) {
  const seqFrom = overrides.seqFrom ?? 1;
  const seqTo = overrides.seqTo ?? 2;
  const sessionKey = overrides.sessionKey ?? "claude-code:/tmp/session.jsonl";
  return {
    id: overrides.id ?? uploadId(sessionKey, seqFrom, seqTo),
    sessionKey,
    agentKind: "claude-code",
    machineId: "m1",
    externalId: "s1",
    session: { external_id: "s1" },
    seqFrom,
    seqTo,
    events: overrides.events ?? [
      { seq: seqFrom, at: "2026-10-17T00:00:00.000Z", role: "user", text: "a" },
      { seq: seqTo, at: "2026-10-17T00:00:01.000Z", role: "assistant", text: "b" },
    ],
    createdAt: overrides.createdAt ?? 1000,
    attempts: 0,
    nextAttemptAt: overrides.nextAttemptAt ?? 1000,
  };
}

function tempRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "agentd-queue-"));
  return { root: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("queue: enqueue is idempotent per seq range (watcher + poll dedup at the queue level)", async () => {
  const { root, cleanup } = tempRoot();
  const queue = new UploadQueue({ root, now: () => 1000 });

  await queue.enqueue(item());
  await queue.enqueue(item());

  assert.equal((await queue.list()).length, 1);
  cleanup();
});

test("queue: items persist across instances and sort per session by seq", async () => {
  const { root, cleanup } = tempRoot();
  const first = new UploadQueue({ root, now: () => 1000 });
  await first.enqueue(item({ seqFrom: 5, seqTo: 6, createdAt: 999 }));
  await first.enqueue(item({ seqFrom: 1, seqTo: 2, createdAt: 1000 }));

  const second = new UploadQueue({ root, now: () => 1000 });
  const list = await second.listForSession("claude-code:/tmp/session.jsonl");

  assert.deepEqual(list.map((i) => [i.seqFrom, i.seqTo]), [[1, 2], [5, 6]]);
  cleanup();
});

test("queue: exponential backoff, capped at ten minutes", () => {
  assert.equal(backoffMs(0), 2000);
  assert.equal(backoffMs(1), 4000);
  assert.equal(backoffMs(5), 64000);
  assert.equal(backoffMs(20), MAX_BACKOFF_MS);
  assert.equal(MAX_BACKOFF_MS, 600000);
});

test("queue: markAttempt schedules the retry and keeps the batch", async () => {
  const { root, cleanup } = tempRoot();
  let now = 1000;
  const queue = new UploadQueue({ root, now: () => now });
  await queue.enqueue(item());

  await queue.markAttempt(item().id, "network down");
  const [stored] = await queue.list();

  assert.equal(stored.attempts, 1);
  assert.equal(stored.nextAttemptAt, now + 2000);
  assert.equal(stored.lastError, "network down");
  cleanup();
});

test("queue: over the byte cap evicts the oldest uploads and says so", async () => {
  const { root, cleanup } = tempRoot();
  const diagnostics = [];
  const queue = new UploadQueue({
    root,
    now: () => 1000,
    maxBytes: 900, // 大约装得下两项
    log: { info: () => {}, error: (m) => diagnostics.push(m) },
  });

  for (let i = 0; i < 5; i += 1) {
    await queue.enqueue(item({ seqFrom: i * 10 + 1, seqTo: i * 10 + 2, createdAt: 1000 + i }));
  }

  const remaining = await queue.list();
  assert.ok(remaining.length < 5);
  assert.ok(diagnostics.some((line) => line.includes("evicted oldest upload")));
  // 最老的先走：剩下的最大 seqFrom 比被删的更晚
  assert.ok(Math.min(...remaining.map((i) => i.seqFrom)) > 1);
  cleanup();
});

test("queue: 413 splitting halves by events and keeps seq ranges exact", () => {
  const original = item({
    seqFrom: 1,
    seqTo: 4,
    events: [1, 2, 3, 4].map((seq) => ({ seq, at: "2026-10-17T00:00:00.000Z", role: "user", text: `e${seq}` })),
  });

  const parts = splitUpload(original);

  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => [p.seqFrom, p.seqTo, p.events.map((e) => e.seq)]), [
    [1, 2, [1, 2]],
    [3, 4, [3, 4]],
  ]);
  assert.notEqual(parts[0].id, parts[1].id);
  assert.notEqual(parts[0].id, original.id);
});

test("queue: a single-event batch cannot be split further", () => {
  const original = item({ seqFrom: 7, seqTo: 7, events: [{ seq: 7, at: "2026-10-17T00:00:00.000Z", role: "user", text: "x".repeat(8000) }] });
  assert.deepEqual(splitUpload(original), [original]);
});
