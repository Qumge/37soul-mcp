#!/usr/bin/env node
/**
 * C1/H1: cloud sync is triggered through the single-writer seam, and the writer's
 * transport is injected at the composition root (never `globalThis.fetch`).
 *
 * Everything runs against a temp root with a fake HTTP transport — no network, no
 * real token. The `sync_once` writer command is dispatched through the real
 * in-process writer (startWriter/sendWriter), so these tests exercise the same
 * socket path production uses, not a mocked store write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { acquireWriterLock, openStore } from "../dist/local/store.js";
import { sendWriter, startWriter } from "../dist/local/writer.js";
import { clampSyncTimeoutMs, configureSyncHttp, DEFAULT_SYNC_TIMEOUT_MS, isAssetsModeSync } from "../dist/sync/client.js";
import { runSync, runSyncProfiles } from "../dist/sync/run.js";

function tempDir(prefix = "sync-run-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

const EMPTY_PULL = { protocol: "soul-assets/v1", events: [], next_cursor: null, has_more: false };

function makeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: { cancel: async () => {} },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A fake transport that records calls and answers GET /pull with an empty page. */
function fakeHttp({ onCall } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const http = async (url, init = {}) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push({ url: String(url), method: init.method ?? "GET" });
    try {
      onCall?.(calls[calls.length - 1], calls.length);
      return makeResponse(200, EMPTY_PULL);
    } finally {
      inFlight -= 1;
    }
  };
  http.calls = calls;
  http.maxInFlight = () => maxInFlight;
  return http;
}

function seedAssetsProfile(root, profileId = "p1", deviceId = "dev-1") {
  mkdirSync(path.join(root, "profiles", profileId), { recursive: true });
  writeFileSync(path.join(root, "profiles", profileId, "device.json"), `${JSON.stringify({ device_id: deviceId })}\n`, {
    mode: 0o600,
  });
}

function seedAccounts(root, entries) {
  writeFileSync(path.join(root, "accounts.json"), `${JSON.stringify(entries)}\n`, { mode: 0o600 });
}

function seedConfig(root) {
  writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({ api_base_url: "https://fake.test", machine_id: "m1", tokens: { "claude-code": "test-token" } })}\n`,
    { mode: 0o600 },
  );
}

async function seedEmptyStore(root, profileId) {
  const store = await openStore(root, profileId);
  await store.transact(() => {});
  await store.close();
}

// ---------------------------------------------------------------------------
// H1: the sync_once writer command never reads globalThis.fetch
// ---------------------------------------------------------------------------

test("H1: sync_once uses the injected transport and never calls globalThis.fetch", async () => {
  const root = tempDir();
  seedAssetsProfile(root);
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "s1", soul_sync_mode: "assets_only" } });
  seedConfig(root);
  await seedEmptyStore(root, "p1");

  const realFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    throw new Error("globalThis.fetch must never be called by sync_once");
  };

  const http = fakeHttp();
  try {
    configureSyncHttp(http);
    const writer = await startWriter(root);
    try {
      const res = await sendWriter(root, { request_uid: "r1", profile_id: "p1", command: "sync_once", payload: {} });
      assert.equal(res.ok, true, `sync_once accepted: ${JSON.stringify(res)}`);
      assert.equal(res.result.error, undefined, "no error on a clean sync");
      assert.ok(http.calls.length > 0, "the injected transport was used");
      assert.equal(globalCalls, 0, "globalThis.fetch was never called");
    } finally {
      await writer.close();
    }
  } finally {
    globalThis.fetch = realFetch;
    configureSyncHttp(null);
  }
  rmSync(root, { recursive: true, force: true });
});

test("H1: an unconfigured writer fails sync_once with the typed http_not_configured error", async () => {
  const root = tempDir();
  seedAssetsProfile(root);
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "s1", soul_sync_mode: "assets_only" } });

  configureSyncHttp(null);
  const writer = await startWriter(root);
  try {
    const res = await sendWriter(root, { request_uid: "r2", profile_id: "p1", command: "sync_once", payload: {} });
    assert.equal(res.ok, false, "sync_once must refuse without a transport");
    assert.equal(res.error.code, "http_not_configured");
  } finally {
    await writer.close();
  }
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// C1: the sync_once gate + runSync/runSyncProfiles through the writer seam
// ---------------------------------------------------------------------------

test("C1: sync_once refuses in legacy mode with 'assets mode is not enabled'", async () => {
  const root = tempDir();
  seedAssetsProfile(root);
  seedConfig(root);
  await seedEmptyStore(root, "p1");
  // No accounts.json entry in assets mode -> legacy transcript mode.
  assert.equal(isAssetsModeSync(root), false);

  const http = fakeHttp();
  configureSyncHttp(http);
  const writer = await startWriter(root);
  try {
    const res = await sendWriter(root, { request_uid: "r3", profile_id: "p1", command: "sync_once", payload: {} });
    assert.equal(res.ok, true, "the writer answers (with a gate error in the report)");
    assert.equal(res.result.error, "assets mode is not enabled");
    assert.equal(http.calls.length, 0, "no HTTP work in legacy mode");
  } finally {
    await writer.close();
    configureSyncHttp(null);
  }
  rmSync(root, { recursive: true, force: true });
});

test("C1: runSync dispatches through the writer (starts a transient writer when none is listening)", async () => {
  const root = tempDir();
  seedAssetsProfile(root);
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "s1", soul_sync_mode: "assets_only" } });
  seedConfig(root);
  await seedEmptyStore(root, "p1");

  const http = fakeHttp();
  configureSyncHttp(http);
  try {
    const report = await runSync(root, "p1");

    assert.deepEqual(report, { accepted: 0, conflicts: 0, pending: 0 }, "a clean sync reports zeroed counts and no error");
    assert.ok(http.calls.length > 0, "the sync actually pushed/pulled through the writer");
  } finally {
    configureSyncHttp(null);
  }
  rmSync(root, { recursive: true, force: true });
});

test("C1: runSync never bypasses the writer — a held lock surfaces writer_unavailable", async () => {
  const root = tempDir();
  seedAssetsProfile(root);
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "s1", soul_sync_mode: "assets_only" } });
  seedConfig(root);
  await seedEmptyStore(root, "p1");

  const releaseLock = await acquireWriterLock(root);
  const http = fakeHttp();
  configureSyncHttp(http);
  try {
    const report = await runSync(root, "p1");
    assert.equal(report.error, "writer_unavailable", "the writer failure is surfaced, not a lockless write");
    assert.equal(http.calls.length, 0, "no HTTP work happens without the writer lock");
  } finally {
    configureSyncHttp(null);
    await releaseLock();
  }
  rmSync(root, { recursive: true, force: true });
});

test("C1: runSyncProfiles syncs only assets-mode profiles, sequentially", async () => {
  const root = tempDir();
  seedAssetsProfile(root, "p1");
  seedAssetsProfile(root, "p2");
  seedAssetsProfile(root, "p3");
  seedAccounts(root, {
    "owner-1": { profile_id: "p1", default_soul_uid: "s1", soul_sync_mode: "assets_only" },
    "owner-2": { profile_id: "p2", default_soul_uid: null, soul_sync_mode: null },
    "owner-3": { profile_id: "p3", default_soul_uid: "s3", soul_sync_mode: "assets_only" },
  });
  seedConfig(root);
  await seedEmptyStore(root, "p1");
  await seedEmptyStore(root, "p3");

  const http = fakeHttp();
  configureSyncHttp(http);
  let reports;
  try {
    reports = await runSyncProfiles(root);
  } finally {
    configureSyncHttp(null);
  }

  assert.deepEqual(
    reports.map((r) => r.profile_id),
    ["p1", "p3"],
    "only assets-only profiles are synced, in accounts order",
  );
  assert.ok(reports.every((r) => r.report.error === undefined), "each assets-only profile synced cleanly");
  assert.equal(http.maxInFlight(), 1, "profiles are synced sequentially, never concurrently");
  rmSync(root, { recursive: true, force: true });
});

test("runSync bounds each request with the default timeout constant", () => {
  assert.equal(DEFAULT_SYNC_TIMEOUT_MS, 30_000);
});

test("clampSyncTimeoutMs clamps integers into [1000, 60000] and defaults on absent/invalid", () => {
  assert.equal(clampSyncTimeoutMs(50), 1_000);
  assert.equal(clampSyncTimeoutMs(1_000), 1_000);
  assert.equal(clampSyncTimeoutMs(60_000), 60_000);
  assert.equal(clampSyncTimeoutMs(200_000), 60_000);
  assert.equal(clampSyncTimeoutMs(undefined), 30_000);
  assert.equal(clampSyncTimeoutMs(null), 30_000);
  assert.equal(clampSyncTimeoutMs("50"), 30_000);
  assert.equal(clampSyncTimeoutMs(1.5), 30_000);
});

/** A transport whose requests never settle until their AbortSignal fires. */
function neverResolvingHttp() {
  const signals = [];
  const http = async (_url, init = {}) => {
    const signal = init.signal ?? null;
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      if (signal) signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  http.signals = signals;
  return http;
}

test("sync_once bounds a hung transport with the writer-side timeout (payload timeout_ms aborts)", async () => {
  const root = tempDir();
  seedAssetsProfile(root);
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "s1", soul_sync_mode: "assets_only" } });
  seedConfig(root);
  await seedEmptyStore(root, "p1");

  const http = neverResolvingHttp();
  configureSyncHttp(http);
  const writer = await startWriter(root);
  try {
    const started = Date.now();
    // A sentinel keeps the suite from hanging if the writer-side timeout regresses.
    let timer;
    const sentinel = new Promise((resolve) => {
      timer = setTimeout(() => resolve("test-timeout"), 30_000);
    });
    const res = await Promise.race([
      sendWriter(root, { request_uid: "r-timeout", profile_id: "p1", command: "sync_once", payload: { timeout_ms: 50 } }),
      sentinel,
    ]);
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    assert.notEqual(res, "test-timeout", "sync_once must resolve, not hang, when the transport never settles");
    assert.equal(res.ok, true, `writer answered: ${JSON.stringify(res)}`);
    assert.equal(res.result.error, "sync_failed", "a hung transport surfaces the sync_failed error code");
    assert.ok(http.signals.length > 0, "the transport received at least one request signal");
    assert.ok(http.signals.every((s) => s instanceof AbortSignal), "every request carried an AbortSignal");
    assert.ok(http.signals.some((s) => s.aborted), "at least one request was actually aborted by the timeout");
    // timeout_ms:50 clamps up to the 1000ms floor; with the default 2-retry backoff
    // (400ms + 800ms sleeps) the abort path settles in ~4.2s — well under this bound.
    assert.ok(elapsed < 8_000, `bounded wall-clock time: ${elapsed}ms`);
  } finally {
    await writer.close();
    configureSyncHttp(null);
  }
  rmSync(root, { recursive: true, force: true });
});
