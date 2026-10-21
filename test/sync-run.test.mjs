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
import { createServer } from "node:http";
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
    `${JSON.stringify({
      api_base_url: "https://fake.test",
      machine_id: "m1",
      tokens: { "claude-code": "test-token" },
      credentials: [
        {
          token: "test-token",
          owner_id: "owner-1",
          cloud_device_uid: "cdu-1",
          runtime_kind: "claude-code",
          profile_id: "p1",
          obtained_at: "2026-10-21T00:00:00Z",
        },
        {
          token: "test-token-3",
          owner_id: "owner-3",
          cloud_device_uid: "cdu-3",
          runtime_kind: "claude-code",
          profile_id: "p3",
          obtained_at: "2026-10-21T00:00:00Z",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
}

async function seedEmptyStore(root, profileId, ownerId = "owner-1", cloudDeviceUid = "cdu-1") {
  const store = await openStore(root, profileId);
  await store.transact((draft) => {
    draft.owner_id = ownerId;
    draft.cloud_device_uid = cloudDeviceUid;
  });
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
  await seedEmptyStore(root, "p3", "owner-3", "cdu-3");

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

// ---------------------------------------------------------------------------
// R1/R3: credentials are scoped to profile/owner/device/runtime
// ---------------------------------------------------------------------------

function seedScopedConfig(root, entries) {
  writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({
      api_base_url: "https://fake.test",
      machine_id: "m1",
      tokens: {},
      credentials: entries,
    })}\n`,
    { mode: 0o600 },
  );
}

async function seedOwnedStore(root, profileId, deviceId, ownerId, cloudDeviceUid, change) {
  seedAssetsProfile(root, profileId, deviceId);
  const store = await openStore(root, profileId);
  await store.transact((draft) => {
    draft.owner_id = ownerId;
    draft.cloud_device_uid = cloudDeviceUid;
    change?.(draft);
  });
  await store.close();
}

test("R1: syncing all profiles never sends profile A with profile B's token", async () => {
  const root = tempDir();
  await seedOwnedStore(root, "pA", "dev-A", "owner-A", "cdu-A", (d) => {
    d.souls["soul-A"] = {
      soul_uid: "soul-A", legacy_host_id: 1, identity_revision: 1,
      identity: { name: "A", description: "", character: "", greeting: "" }, state: "active",
    };
  });
  await seedOwnedStore(root, "pB", "dev-B", "owner-B", "cdu-B");
  seedAccounts(root, {
    "owner-A": { profile_id: "pA", default_soul_uid: "soul-A", soul_sync_mode: "assets_only" },
    "owner-B": { profile_id: "pB", default_soul_uid: null, soul_sync_mode: "assets_only" },
  });
  seedScopedConfig(root, [
    { token: "token-A", owner_id: "owner-A", cloud_device_uid: "cdu-A", runtime_kind: "hermes", profile_id: "pA", obtained_at: "x" },
    { token: "token-B", owner_id: "owner-B", cloud_device_uid: "cdu-B", runtime_kind: "hermes", profile_id: "pB", obtained_at: "x" },
  ]);

  const calls = [];
  const http = async (url, init = {}) => {
    const auth = String((init.headers ?? {}).authorization ?? "");
    calls.push({ url: String(url), auth });
    if (String(url).includes("/pull")) {
      const body = auth.includes("token-B")
        ? { protocol: "soul-assets/v1", events: [{ event_uid: "b-soul", object_type: "soul", object: { soul_uid: "soul-B", legacy_host_id: 2, identity_revision: 1, identity: { name: "B", description: "", character: "", greeting: "" }, state: "active" } }], next_cursor: "cb", has_more: false }
        : { protocol: "soul-assets/v1", events: [], next_cursor: "ca", has_more: false };
      return makeResponse(200, body);
    }
    return makeResponse(200, EMPTY_PULL);
  };

  configureSyncHttp(http);
  try {
    await runSyncProfiles(root);
  } finally {
    configureSyncHttp(null);
  }
  const tokens = calls.map((call) => call.auth);
  assert.ok(tokens.includes("Bearer token-A"));
  assert.ok(tokens.includes("Bearer token-B"));
  const aCalls = tokens.slice(0, 1);
  assert.deepEqual(aCalls, ["Bearer token-A"], "profile A used only its own token");
  const aStore = await openStore(root, "pA");
  const aSnap = await aStore.read();
  await aStore.close();
  assert.equal(aSnap.souls["soul-B"], undefined, "profile A never received profile B's Soul");
  rmSync(root, { recursive: true, force: true });
});

test("R3: bindings use the token of their own runtime", async () => {
  const root = tempDir();
  const runtimes = ["claude-code", "codex", "opencode", "hermes"];
  await seedOwnedStore(root, "p1", "dev-1", "owner-1", "cdu-1", (d) => {
    runtimes.forEach((runtime, index) => {
      const key = ["p1", "dev-1", runtime, `ns-${index}`].join("\u0000");
      d.bindings[key] = {
        binding_uid: `binding-${runtime}`, session_ref: `session-${runtime}`, runtime_kind: runtime,
        soul_uid: "soul-1", revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1",
        native_session_id: `ns-${index}`,
      };
      d.outbox[`op-${runtime}`] = {
        operation_id: `op-${runtime}`, operation_kind: "binding",
        request: { base_revision: 0, session_ref: `session-${runtime}`, runtime_kind: runtime, soul_uid: "soul-1", state: "bound" },
        predecessor_operation_ids: [],
      };
      d.assets[`asset-${runtime}`] = {
        asset_uid: `asset-${runtime}`, soul_uid: "soul-1", kind: "relationship", trait: "preference",
        content: `fact from ${runtime}`, applicability: "", tags: [], evidence: "explicit_user_statement",
        verification: "unverified", sensitivity: "normal", state: "active", revision: 1,
        supersedes_uid: null, pinned: false,
        source: { runtime_kind: runtime, session_ref: `session-${runtime}`, event_ref: `e-${runtime}`, occurred_at: "2026-10-20T04:00:00Z" },
        sync_state: "pending_sync", cloud_revision: null,
      };
      d.outbox[`asset-op-${runtime}`] = {
        operation_id: `asset-op-${runtime}`, operation_kind: "asset",
        request: {
          change_id: `asset-${runtime}`, operation: "propose", soul_uid: "soul-1",
          asset_uid: `asset-${runtime}`, base_revision: 0, actor: "model",
          binding_uid: `binding-${runtime}`, binding_revision: 1,
          payload: {
            kind: "relationship", trait: "preference", content: `fact from ${runtime}`,
            applicability: "", tags: [], evidence: "explicit_user_statement",
            verification: "unverified", sensitivity: "normal",
            source: { runtime_kind: runtime, session_ref: `session-${runtime}`, event_ref: `e-${runtime}`, occurred_at: "2026-10-20T04:00:00Z" },
          },
        },
        predecessor_operation_ids: [],
      };
    });
  });
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "soul-1", soul_sync_mode: "assets_only" } });
  seedScopedConfig(root, runtimes.map((runtime) => ({
    token: `token-${runtime}`, owner_id: "owner-1", cloud_device_uid: "cdu-1",
    runtime_kind: runtime, profile_id: "p1", obtained_at: "x",
  })));

  const seen = [];
  const seenAssets = [];
  const http = async (url, init = {}) => {
    const p = new URL(String(url)).pathname;
    if (init.method === "PUT" && p.includes("/bindings/")) {
      const runtime = JSON.parse(String(init.body)).runtime_kind;
      seen.push({ runtime, auth: String((init.headers ?? {}).authorization ?? "") });
      return makeResponse(200, { protocol: "soul-assets/v1", binding: JSON.parse(String(init.body)) });
    }
    if (init.method === "POST" && p.endsWith("/push")) {
      const changes = JSON.parse(String(init.body)).changes;
      for (const change of changes) {
        seenAssets.push({ runtime: change.payload.source.runtime_kind, auth: String((init.headers ?? {}).authorization ?? "") });
      }
      return makeResponse(200, {
        protocol: "soul-assets/v1",
        results: changes.map((change) => ({
          change_id: change.change_id,
          status: "accepted",
          applied_revisions: [{ object_uid: change.asset_uid, revision: 1 }],
          objects: [{
            object_type: "asset",
            object: {
              asset_uid: change.asset_uid, soul_uid: change.soul_uid, kind: "relationship",
              trait: "preference", content: change.payload.content, applicability: "", tags: [],
              evidence: "explicit_user_statement", verification: "unverified", sensitivity: "normal",
              state: "active", revision: 1, supersedes_uid: null, pinned: false,
              source: change.payload.source,
            },
          }],
          error: null,
        })),
      });
    }
    return makeResponse(200, EMPTY_PULL);
  };
  configureSyncHttp(http);
  try {
    await runSync(root, "p1");
  } finally {
    configureSyncHttp(null);
  }
  assert.equal(seen.length, 4, "all four binding changes were sent");
  for (const entry of seen) {
    assert.equal(entry.auth, `Bearer token-${entry.runtime}`, `${entry.runtime} used its own token`);
  }
  assert.equal(seenAssets.length, 4, "all four runtime assets were pushed");
  for (const entry of seenAssets) {
    assert.equal(entry.auth, `Bearer token-${entry.runtime}`, `${entry.runtime} asset used its own token`);
  }
  rmSync(root, { recursive: true, force: true });
});


// R5: a server that flushes headers and then stalls the body must still hit the
// writer-side deadline, release the writer, and let the next command run.
test("R5: headers-then-stalled-body is bounded and the writer recovers", async () => {
  const root = tempDir();
  await seedOwnedStore(root, "p1", "dev-1", "owner-1", "cdu-1", (d) => {
    d.bindings[["p1", "dev-1", "claude-code", "ns-1"].join("\u0000")] = {
      binding_uid: "binding-1", session_ref: "session-1", runtime_kind: "claude-code",
      soul_uid: "soul-1", revision: 1, state: "bound", profile_id: "p1",
      device_id: "dev-1", native_session_id: "ns-1",
    };
    d.outbox["binding-op"] = {
      operation_id: "binding-op",
      operation_kind: "binding",
      request: { base_revision: 0, session_ref: "session-1", runtime_kind: "claude-code", soul_uid: "soul-1", state: "bound" },
      predecessor_operation_ids: [],
    };
  });
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "soul-1", soul_sync_mode: "assets_only" } });
  seedScopedConfig(root, [{
    token: "token-1", owner_id: "owner-1", cloud_device_uid: "cdu-1",
    runtime_kind: "claude-code", profile_id: "p1", obtained_at: "x",
  }]);

  let stalled = false;
  const server = createServer((req, res) => {
    if (!req.url?.includes("/pull")) {
      stalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"protocol":"soul-assets/v1","results":');
      // Deliberately never end the body.
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(EMPTY_PULL));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const previousBase = process.env.SOUL37_BASE_URL;
  // The writer resolves the base URL from config; rewrite it to the local server.
  writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({
      api_base_url: `http://127.0.0.1:${port}`,
      machine_id: "m1",
      tokens: {},
      credentials: [{
        token: "token-1", owner_id: "owner-1", cloud_device_uid: "cdu-1",
        runtime_kind: "claude-code", profile_id: "p1", obtained_at: "x",
      }],
    })}\n`,
    { mode: 0o600 },
  );

  configureSyncHttp(globalThis.fetch);
  const writer = await startWriter(root);
  try {
    const started = Date.now();
    let sentinelTimer;
    const sentinel = new Promise((resolve) => {
      sentinelTimer = setTimeout(() => resolve("test-timeout"), 10_000);
    });
    const res = await Promise.race([
      sendWriter(root, {
        request_uid: "r-stall",
        profile_id: "p1",
        command: "sync_once",
        payload: { timeout_ms: 1_000 },
      }),
      sentinel,
    ]);
    clearTimeout(sentinelTimer);
    const elapsed = Date.now() - started;
    assert.notEqual(res, "test-timeout", "sync_once must not hang on a stalled body");
    assert.equal(res.ok, true, `writer answered: ${JSON.stringify(res)}`);
    assert.ok(stalled, "the server actually stalled after the headers");
    assert.ok(elapsed < 6_000, `bounded wall-clock time: ${elapsed}ms`);
    const next = await sendWriter(root, {
      request_uid: "r-after-stall",
      profile_id: "p1",
      command: "status",
      payload: {},
    });
    assert.equal(next.ok, true, `the writer accepts the next command after the timeout: ${JSON.stringify(next)}`);
  } finally {
    // A failed regression (timer cleared at headers) must not hang the suite:
    // destroy the stalled socket and bound the writer close.
    server.closeAllConnections?.();
    await Promise.race([
      writer.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    configureSyncHttp(null);
    await new Promise((resolve) => server.close(resolve));
    if (previousBase === undefined) delete process.env.SOUL37_BASE_URL;
    else process.env.SOUL37_BASE_URL = previousBase;
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1: a legacy global token is not guessed into a scoped profile", async () => {
  const root = tempDir();
  await seedOwnedStore(root, "p1", "dev-1", "owner-1", "cdu-1", (d) => {
    d.souls["soul-1"] = {
      soul_uid: "soul-1", legacy_host_id: 1, identity_revision: 1,
      identity: { name: "A", description: "", character: "", greeting: "" }, state: "active",
    };
  });
  seedAccounts(root, { "owner-1": { profile_id: "p1", default_soul_uid: "soul-1", soul_sync_mode: "assets_only" } });
  writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({ api_base_url: "https://fake.test", machine_id: "m1", tokens: { "claude-code": "legacy-unbound" } })}\n`,
    { mode: 0o600 },
  );
  let calls = 0;
  const http = async () => { calls += 1; return makeResponse(200, EMPTY_PULL); };
  configureSyncHttp(http);
  try {
    const report = await runSync(root, "p1");
    assert.equal(report.error, "no authorized device token");
    assert.equal(calls, 0, "an unbound legacy token never reaches the network");
  } finally {
    configureSyncHttp(null);
  }
  const snap = await openStore(root, "p1");
  const stored = await snap.read();
  await snap.close();
  assert.ok(stored.souls["soul-1"], "the local Soul is retained for an explicit re-login");
  rmSync(root, { recursive: true, force: true });
});
