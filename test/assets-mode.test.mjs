#!/usr/bin/env node
/**
 * Task 10 upgrade contract: assets-only mode fails closed.
 *
 * Two halves, tested against the real modules (no network, no transport boot):
 *
 *  1. The legacy write drain is inert in assets mode: `uploadBatch` receives
 *     `tokens = {}` (from `startAgentd`), so a pre-seeded spool/queue produces
 *     zero old write requests — `tokenFor` returns null and it short-circuits
 *     to "unauthorized" before any fetch.
 *
 *  2. A server-side 410 `assets_only_mode` surfaces as an explicit MCP error
 *     through `statusError`: the tool result is an error, names the 410
 *     assets-only mode, never downgrades to a generic "unavailable" message,
 *     never retries (statusError is a pure one-shot mapping) and never reports
 *     success.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { uploadBatch } from "../dist/agentd/uploader.js";
import { createDaemon } from "../dist/agentd/daemon.js";
import { UploadQueue } from "../dist/agentd/queue.js";
import { statusError } from "../dist/mcp/status.js";

const T0 = Date.parse("2026-10-17T05:00:00.000Z");

function tempDir(prefix = "assets-mode-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function queuedItem() {
  return {
    id: "claude-code:session-fixture:1-2",
    sessionKey: "claude-code:session-fixture",
    agentKind: "claude-code",
    machineId: "machine-1",
    externalId: "session-fixture",
    session: { external_id: "session-fixture" },
    seqFrom: 1,
    seqTo: 2,
    events: [
      { seq: 1, at: new Date(T0).toISOString(), role: "user", text: "hi" },
      { seq: 2, at: new Date(T0 + 1000).toISOString(), role: "assistant", text: "hello" },
    ],
    createdAt: T0,
    attempts: 0,
    nextAttemptAt: T0,
  };
}

// ── Deliverable 3: 410 assets_only_mode surfaces as an explicit MCP error ──────

test("status: a server 410 assets_only_mode is surfaced as an explicit MCP error, never downgraded or reported as success", () => {
  const res = new Response("", { status: 410 });

  for (const ctx of ["remember", "update_host", "checkpoint", "log_turn", "facts"]) {
    const result = statusError(res, ctx, "https://37soul.com");
    assert.ok(result, `${ctx} must produce an explicit error for 410`);
    assert.equal(result.isError, true, `${ctx} 410 must be an error, never success`);
    const message = result.content.map((block) => block.text).join("\n");
    assert.match(message, /410 assets_only_mode/, `${ctx} 410 must name assets_only_mode`);
    assert.match(message, /assets-only mode/, `${ctx} 410 must say assets-only mode`);
    // Never downgraded to the generic "unavailable" or "temporarily unavailable" text.
    assert.doesNotMatch(message, /unavailable|Try again shortly/, `${ctx} 410 must not downgrade to a generic retryable error`);
    // Never instructed to retry.
    assert.doesNotMatch(message, /safe to retry|retry this/, `${ctx} 410 must never advise a retry`);
    // Identity is edited on the website, not by the legacy write path.
    assert.match(message, /37soul\.com/, `${ctx} 410 must point identity edits at the website`);
  }
});

test("status: a 410 for any legacy context is the same fail-closed message (no context-specific downgrade)", () => {
  const remember = statusError(new Response("", { status: 410 }), "remember", "https://37soul.com");
  const checkpoint = statusError(new Response("", { status: 410 }), "checkpoint", "https://37soul.com");
  assert.deepEqual(remember, checkpoint, "410 is a hard, context-independent refusal");
});

test("status: an ok response maps to null (the caller proceeds with the parsed body)", () => {
  assert.equal(statusError(new Response("{}", { status: 200 }), "remember", "https://37soul.com"), null);
});

// ── Deliverable 2: legacy queues are inert in assets mode ──────────────────────

test("upload: with no tokens (assets mode), uploadBatch short-circuits to unauthorized before any fetch", async () => {
  let fetches = 0;
  const outcome = await uploadBatch(
    {
      baseUrl: "https://api.test",
      fetch: async () => { fetches += 1; return new Response("{}", { status: 202 }); },
      tokenFor: () => null, // assets mode forces tokens = {}
    },
    queuedItem(),
  );
  assert.equal(fetches, 0, "no old write request may leave the machine in assets mode");
  assert.equal(outcome.status, "unauthorized");
  assert.match(outcome.error, /no token configured/);
});

test("daemon: a pre-seeded legacy queue in assets mode uploads nothing across a tick", async () => {
  const root = tempDir();
  const requests = [];
  const queue = new UploadQueue({ root, now: () => T0 });

  // Pre-seed a legacy queued upload (the old capture path's durable queue item).
  await queue.enqueue(queuedItem());

  const daemon = createDaemon(
    {
      root,
      apiBaseUrl: "https://api.test",
      machineId: "machine-1",
      // assets mode: tokens forced to {}, no transcript fallback
      tokens: {},
      home: root,
      transcriptFallback: [],
    },
    {
      log: { info() {}, error() {} },
      fetch: async () => {
        requests.push(1);
        return new Response("{}", { status: 202 });
      },
      queue,
      now: () => T0,
    },
  );

  await daemon.tick();
  assert.equal(requests.length, 0, "zero old write requests in assets mode");

  rmSync(root, { recursive: true, force: true });
});
