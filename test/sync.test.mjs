#!/usr/bin/env node
/**
 * Task 5: sync tests for the cloud boundary (soul-assets/v1 push/pull/receipts).
 *
 * Every test injects a fake `HttpFetch` (never the real one) plus a temp root, so
 * no request can ever reach production. The fake HTTP routes by URL path and the
 * assertions run against the *local store* after each run — the contract behaviour,
 * not the server's internals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openStore, defaultStoreFs, StoreError } from "../dist/local/store.js";
import { selectContext } from "../dist/assets/context.js";
import { contentDigest } from "../dist/assets/protocol.js";
import {
  applyPullPage,
  ownerContextInput,
  recordReceipt,
  reviewAsset,
  syncOnce,
} from "../dist/sync/client.js";
import { loadContractFixture } from "./helpers/contract-fixture.mjs";
import { assertBindingCurrent, detachBinding, resolveBinding, selectSoul } from "../dist/local/bindings.js";

const { fixture } = loadContractFixture();
const WIRE = fixture.wire_responses;
const IDS = {
  soul: fixture.ids.soul_uid,
  binding: fixture.ids.binding_uid,
  session: fixture.ids.session_ref,
  cloudDevice: fixture.ids.cloud_device_uid,
  owner: fixture.ids.owner_id,
  assetA: "40000000-0000-4000-8000-000000000001",
  assetB: "40000000-0000-4000-8000-000000000008",
  changeA: "60000000-0000-4000-8000-000000000001",
};

const PREF = "prefer async over meetings";
const LOCAL_EDIT = "LOCAL EDIT ONLY";
const CLOUD_WINNER = "CLOUD WINNER";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "sync-"));
}

async function seedProfile(root, profileId, deviceId, change) {
  mkdirSync(path.join(root, "profiles", profileId), { recursive: true });
  writeFileSync(
    path.join(root, "profiles", profileId, "device.json"),
    `${JSON.stringify({ device_id: deviceId })}\n`,
    { mode: 0o600 },
  );
  const store = await openStore(root, profileId);
  await store.transact(change ?? (() => {}));
  await store.close();
}

function bindingKeyOf() {
  return ["p1", "dev-1", "hermes", "ns-1"].join("\u0000");
}

/** Seed owner/cloud_device, one Soul, full consent and one bound binding. */
function baseChange(d, overrides = {}) {
  d.owner_id = IDS.owner;
  d.cloud_device_uid = IDS.cloudDevice;
  d.souls[IDS.soul] = {
    soul_uid: IDS.soul,
    legacy_host_id: 7,
    identity_revision: 1,
    identity: { name: "Growth", description: "", character: "", greeting: "" },
    state: "active",
  };
  d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
    cloud_device_uid: IDS.cloudDevice,
    soul_uid: IDS.soul,
    revision: 1,
    categories: ["identity", "relationship", "experience"],
    enabled: true,
  };
  d.bindings[bindingKeyOf()] = {
    binding_uid: IDS.binding,
    session_ref: IDS.session,
    runtime_kind: "hermes",
    soul_uid: IDS.soul,
    revision: 1,
    state: "bound",
    profile_id: "p1",
    device_id: "dev-1",
    native_session_id: "ns-1",
  };
  Object.assign(d, overrides);
}

function localAsset(assetUid, content, state = "active", syncState = "pending_sync", cloudRevision = null, revision = 1) {
  return {
    asset_uid: assetUid,
    soul_uid: IDS.soul,
    kind: "relationship",
    trait: "preference",
    content,
    applicability: "客户分析",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state,
    revision,
    supersedes_uid: null,
    pinned: false,
    source: { runtime_kind: "hermes", session_ref: IDS.session, event_ref: "e1", occurred_at: "2026-10-20T04:00:00Z" },
    sync_state: syncState,
    cloud_revision: cloudRevision,
  };
}

function proposeOp(assetUid, content, { bindingRevision = 1 } = {}) {
  return {
    operation_id: assetUid,
    operation_kind: "asset",
    request: {
      change_id: assetUid,
      operation: "propose",
      soul_uid: IDS.soul,
      asset_uid: assetUid,
      base_revision: 0,
      actor: "model",
      binding_uid: IDS.binding,
      binding_revision: bindingRevision,
      payload: {
        kind: "relationship",
        trait: "preference",
        content,
        applicability: "客户分析",
        tags: [],
        evidence: "explicit_user_statement",
        verification: "unverified",
        sensitivity: "normal",
        source: { runtime_kind: "hermes", session_ref: IDS.session, event_ref: "e1", occurred_at: "2026-10-20T04:00:00Z" },
      },
    },
    predecessor_operation_ids: [],
  };
}

function fakeHttp(handler) {
  const requests = [];
  const http = async (url, init = {}) => {
    const method = init.method ?? "GET";
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const req = { url, method, body, headers: init.headers ?? {} };
    requests.push(req);
    const response = await handler(req);
    return makeResponse(response);
  };
  http.requests = requests;
  return http;
}

function makeResponse(response) {
  const { status, body, headers = {} } = response;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: { cancel: async () => {} },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function pathnameOf(url) {
  return new URL(url).pathname;
}

function syncOpts(root) {
  return {
    root,
    token: "test-token",
    baseUrl: "https://fake.test",
    backoff: { sleep: async () => {}, maxRetries: 1 },
  };
}

async function readSnap(root, profileId = "p1") {
  const store = await openStore(root, profileId);
  try {
    return await store.read();
  } finally {
    await store.close();
  }
}

const emptyPull = (nextCursor = null) => ({ protocol: "soul-assets/v1", events: [], next_cursor: nextCursor, has_more: false });

function acceptedResult(changeId, asset) {
  return {
    change_id: changeId,
    status: "accepted",
    applied_revisions: [{ object_uid: asset.asset_uid, revision: asset.revision }],
    objects: [{ object_type: "asset", object: asset }],
    error: null,
  };
}

function activeAsset(assetUid, content, revision = 1) {
  return {
    asset_uid: assetUid,
    soul_uid: IDS.soul,
    kind: "relationship",
    trait: "preference",
    content,
    applicability: "客户分析",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state: "active",
    revision,
    supersedes_uid: null,
    pinned: false,
    source: { runtime_kind: "hermes", session_ref: IDS.session, event_ref: "e1", occurred_at: "2026-10-20T04:00:00Z" },
    content_digest: contentDigest(content),
  };
}

// 1 ────────────────────────────────────────────────────────────────────────────────
test("sync: push never advances pull cursor", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d, { pull_cursor: "0" });
    d.assets[IDS.assetA] = localAsset(IDS.assetA, PREF);
    d.outbox[IDS.assetA] = proposeOp(IDS.assetA, PREF);
  });

  const pullCursors = [];
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      const changes = req.body.changes;
      return { status: 200, body: { protocol: "soul-assets/v1", results: changes.map((c) => acceptedResult(c.change_id, activeAsset(c.asset_uid, PREF))) } };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") {
      const cursor = new URL(req.url).searchParams.get("cursor");
      pullCursors.push(cursor);
      return {
        status: 200,
        body: {
          protocol: "soul-assets/v1",
          events: [{ event_uid: "other-1", object_type: "asset", object: activeAsset("other-device-asset", "another device fact") }],
          next_cursor: "c-other",
          has_more: false,
        },
      };
    }
    return { status: 500, body: { error: { code: "unexpected", message: `unexpected ${req.method} ${p}` } } };
  });

  const before = await readSnap(root);
  const beforePush = before.pull_cursor;
  const report = await syncOnce("p1", http, syncOpts(root));
  assert.equal(report.error, undefined, "no fatal error");

  const afterPush = pullCursors[0];
  assert.equal(afterPush, beforePush, "the push phase must not advance the pull cursor");

  const snap = await readSnap(root);
  assert.ok(snap.assets["other-device-asset"], "the other device's old event was applied");
  assert.equal(snap.pull_cursor, "c-other");

  rmSync(root, { recursive: true, force: true });
});

// 2 ────────────────────────────────────────────────────────────────────────────────
test("pull: page and cursor commit together", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => baseChange(d));

  const page = {
    protocol: "soul-assets/v1",
    events: [
      { event_uid: "ev-a", object_type: "asset", object: activeAsset("pull-asset-a", "fact a") },
      { event_uid: "ev-b", object_type: "asset", object: activeAsset("pull-asset-b", "fact b") },
    ],
    next_cursor: "c-x",
    has_more: false,
  };

  let renames = 0;
  const crashingFs = {
    ...defaultStoreFs,
    async rename(from, to) {
      renames += 1;
      if (renames === 1) {
        const err = new Error("injected rename failure");
        err.code = "EIO";
        throw err;
      }
      return defaultStoreFs.rename(from, to);
    },
  };
  const crashingStore = await openStore(root, "p1", { fs: crashingFs });
  await assert.rejects(() => applyPullPage(crashingStore, page), /injected rename failure/);
  await crashingStore.close();

  const untouched = await readSnap(root);
  assert.equal(untouched.pull_cursor, null, "a failed commit leaves the cursor unchanged");
  assert.equal(untouched.assets["pull-asset-a"], undefined, "a failed commit applies no events (all-or-nothing)");
  assert.equal(untouched.assets["pull-asset-b"], undefined, "a failed commit applies no events (all-or-nothing)");

  const store = await openStore(root, "p1");
  await applyPullPage(store, page);
  await store.close();
  const applied = await readSnap(root);
  assert.equal(applied.pull_cursor, "c-x");
  assert.ok(applied.assets["pull-asset-a"] && applied.assets["pull-asset-b"], "the retried page lands events + cursor together");

  rmSync(root, { recursive: true, force: true });
});

// 3 ────────────────────────────────────────────────────────────────────────────────
test("sync: partial push quarantines rejected and conflict", async () => {
  const root = tempDir();
  const uidA = "a-1";
  const uidB = "b-1";
  const uidC = "c-1";
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[uidA] = localAsset(uidA, "a");
    d.assets[uidB] = localAsset(uidB, "b");
    d.assets[uidC] = localAsset(uidC, "c");
    d.outbox[uidA] = proposeOp(uidA, "a");
    d.outbox[uidB] = proposeOp(uidB, "b");
    d.outbox[uidC] = proposeOp(uidC, "c");
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      return {
        status: 200,
        body: {
          protocol: "soul-assets/v1",
          results: [
            acceptedResult(uidA, activeAsset(uidA, "a")),
            { change_id: uidB, status: "rejected", error: { code: "binding_stale" }, objects: [], applied_revisions: [] },
            { change_id: uidC, status: "conflict", error: { code: "revision_conflict" }, objects: [{ object_type: "asset", object: activeAsset(uidC, "cloud c", 2) }] },
          ],
        },
      };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  const snap = await readSnap(root);

  assert.equal(Object.keys(snap.outbox).length, 0, "all three changes left the outbox");
  assert.equal(snap.assets[uidA].sync_state, "synced", "accepted → synced");
  assert.equal(snap.assets[uidB].state, "candidate", "binding_stale → candidate");
  assert.equal(snap.assets[uidC].sync_state, "conflict", "conflict keeps the local edit flagged");
  assert.ok(snap.quarantine[uidB], "rejected change is quarantined");
  assert.ok(snap.quarantine[uidC], "conflicted change is quarantined");

  rmSync(root, { recursive: true, force: true });
});

// 4 ────────────────────────────────────────────────────────────────────────────────
test("conflict keeps local edit", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, LOCAL_EDIT, "active", "pending_sync", 1, 2);
    d.outbox[IDS.assetA] = proposeOp(IDS.assetA, LOCAL_EDIT);
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      return {
        status: 200,
        body: {
          protocol: "soul-assets/v1",
          results: [{ change_id: IDS.assetA, status: "conflict", error: { code: "revision_conflict" }, objects: [{ object_type: "asset", object: activeAsset(IDS.assetA, CLOUD_WINNER, 3) }] }],
        },
      };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  const snap = await readSnap(root);

  assert.equal(snap.assets[IDS.assetA].content, LOCAL_EDIT, "the local edit is never overwritten");
  assert.equal(snap.assets[IDS.assetA].sync_state, "conflict");
  const q = snap.quarantine[IDS.assetA];
  assert.ok(q, "the conflict is quarantined");
  assert.ok(Array.isArray(q.cloud_objects) && q.cloud_objects.length === 1, "the confirmed cloud copy is kept alongside");

  rmSync(root, { recursive: true, force: true });
});

// 5 ────────────────────────────────────────────────────────────────────────────────
test("sync: per change mismatch is conflict inside 200", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, PREF);
    d.outbox[IDS.assetA] = proposeOp(IDS.assetA, PREF);
    d.outbox["consent-op"] = {
      operation_id: "consent-op",
      operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 0, categories: ["identity", "relationship", "experience"], enabled: true },
      predecessor_operation_ids: [],
    };
  });

  let pushMismatch = null;
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "PUT" && p.includes("/consent")) {
      return { status: 409, body: { error: { code: "idempotency_mismatch", message: "same key, different body" } } };
    }
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      const body = {
        protocol: "soul-assets/v1",
        results: [{ change_id: IDS.assetA, status: "conflict", error: { code: "idempotency_mismatch" }, objects: [] }],
      };
      pushMismatch = { status: 200, body };
      return { status: 200, body };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  const report = await syncOnce("p1", http, syncOpts(root));
  assert.equal(report.error, undefined, "a per-change mismatch inside a 200 push is not fatal");
  assert.equal(pushMismatch.status, 200);
  assert.equal(pushMismatch.body.results[0].error.code, "idempotency_mismatch");

  const snap = await readSnap(root);
  assert.equal(snap.quarantine[IDS.assetA]?.reason, "idempotency_mismatch", "push per-change conflict → quarantine");
  assert.equal(snap.quarantine["consent-op"]?.reason, "idempotency_mismatch", "a consent 409 quarantines under the server's real code, not a hardcoded label");

  rmSync(root, { recursive: true, force: true });
});

// 6 ────────────────────────────────────────────────────────────────────────────────
test("sync: cloud candidate or rejected stops local active injection", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, PREF, "active", "synced", 1, 1);
  });

  const store = await openStore(root, "p1");
  await applyPullPage(store, {
    protocol: "soul-assets/v1",
    events: [{
      event_uid: "ev-reject",
      object_type: "asset",
      object: {
        asset_uid: IDS.assetA,
        soul_uid: IDS.soul,
        kind: "relationship",
        trait: "preference",
        state: "rejected",
        revision: 2,
        content_digest: contentDigest(PREF),
        restored_by_uid: null,
      },
    }],
    next_cursor: "c1",
    has_more: false,
  });
  await store.close();

  const snap = await readSnap(root);
  assert.equal(snap.assets[IDS.assetA].state, "rejected", "the local active asset is invalidated by the cloud tombstone");
  const bundle = selectContext(ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096));
  assert.equal(bundle.manifest.length, 0, "an invalidated asset is no longer injected");

  rmSync(root, { recursive: true, force: true });
});

// 7 ────────────────────────────────────────────────────────────────────────────────
test("sync: deletion survives offline replay", async () => {
  const root = tempDir();
  const tempUid = "temp-propose-uid";
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, PREF, "active", "synced", 1, 1);
    // an old propose with a fresh temp uid re-submitting the same content
    d.assets[tempUid] = localAsset(tempUid, PREF, "candidate", "pending_sync", null, 1);
    d.outbox[tempUid] = proposeOp(tempUid, PREF);
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      return {
        status: 200,
        body: {
          protocol: "soul-assets/v1",
          results: [{
            change_id: tempUid,
            status: "duplicate",
            applied_revisions: [{ object_uid: IDS.assetA, revision: 1 }],
            objects: [{
              object_type: "asset",
              object: {
                asset_uid: IDS.assetA,
                soul_uid: IDS.soul,
                kind: "relationship",
                trait: "preference",
                state: "deleted",
                revision: 2,
                content_digest: contentDigest(PREF),
                restored_by_uid: null,
              },
            }],
            canonical_asset_uid: IDS.assetA,
            error: null,
          }],
        },
      };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  const snap = await readSnap(root);

  assert.equal(snap.outbox[tempUid], undefined, "the replayed propose is drained, not resurrected");
  assert.equal(snap.assets[tempUid], undefined, "the temp uid was remapped to the canonical asset");
  assert.equal(snap.assets[IDS.assetA].state, "deleted", "the current cloud tombstone is applied");
  const tombstones = Object.values(snap.digest_tombstones).flat();
  assert.ok(tombstones.some((t) => t.asset_uid === IDS.assetA && t.revision === 2), "the digest tombstone is recorded");
  const bundle = selectContext(ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096));
  assert.equal(bundle.manifest.length, 0, "no active asset survives the deletion");

  rmSync(root, { recursive: true, force: true });
});

// 8 ────────────────────────────────────────────────────────────────────────────────
test("sync: explicit restore survives old tombstone replay", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, PREF, "deleted", "synced", 2, 2);
    d.digest_tombstones[IDS.soul] = [{
      asset_uid: IDS.assetA,
      soul_uid: IDS.soul,
      kind: "relationship",
      trait: "preference",
      content_digest: contentDigest(PREF),
      revision: 2,
      state: "deleted",
      restored_by_uid: null,
    }];
  });

  const store = await openStore(root, "p1");
  await applyPullPage(store, WIRE.pull_restored);
  await applyPullPage(store, WIRE.pull_tombstone); // delayed old revision-2 replay
  await store.close();

  const snap = await readSnap(root);
  const tombstones = Object.values(snap.digest_tombstones).flat();
  const t = tombstones.find((x) => x.asset_uid === IDS.assetA);
  assert.equal(t.revision, 3, "the older revision-2 tombstone must not roll back the revision-3 restore");
  assert.equal(t.restored_by_uid, IDS.assetB);
  assert.ok(snap.assets[IDS.assetB]?.state === "active", "the restored asset is active");

  const bundle = selectContext(ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096));
  assert.ok(bundle.manifest.some((x) => x.asset_uid === IDS.assetB), "the restored asset is injected");
  assert.ok(!bundle.manifest.some((x) => x.asset_uid === IDS.assetA), "the original uid stays dead");

  await assert.rejects(
    () => reviewAsset(root, "p1", { asset_uid: IDS.assetA, action: "approve" }),
    (error) => error.code === "invalid_state_transition",
    "approve cannot resurrect an invalidated asset",
  );

  rmSync(root, { recursive: true, force: true });
});

// 9 ────────────────────────────────────────────────────────────────────────────────
test("review: approve cannot restore invalidated asset", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, PREF, "deleted", "synced", 2, 2);
    d.assets["candidate-1"] = localAsset("candidate-1", "a candidate", "candidate", "synced", 1, 1);
  });

  await assert.rejects(
    () => reviewAsset(root, "p1", { asset_uid: IDS.assetA, action: "approve" }),
    (error) => error.code === "invalid_state_transition",
  );

  const approved = await reviewAsset(root, "p1", { asset_uid: "candidate-1", action: "approve" });
  assert.equal(approved.state, "active", "a genuine candidate can be approved");

  rmSync(root, { recursive: true, force: true });
});

// 10 ───────────────────────────────────────────────────────────────────────────────
test("sync: duplicate after delete applies current tombstone", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, fixture.requests.push_preference.changes[0].payload.content, "active", "synced", 1, 1);
    d.outbox[IDS.changeA] = {
      operation_id: IDS.changeA,
      operation_kind: "asset",
      request: fixture.requests.push_preference.changes[0],
      predecessor_operation_ids: [],
    };
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") return { status: 200, body: WIRE.duplicate_after_delete };
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  const snap = await readSnap(root);

  assert.equal(WIRE.duplicate_after_delete.results[0].applied_revisions.length, 1, "applied_revisions stays 1");
  const objects = WIRE.duplicate_after_delete.results[0].objects;
  assert.ok(objects.every((o) => o.object_type && o.object), "objects stay wrapped as {object_type, object}");
  assert.equal(snap.assets[IDS.assetA].state, "deleted", "the current tombstone is applied, not the old body");
  assert.equal(snap.outbox[IDS.changeA], undefined, "the duplicate is drained");

  const rejectedUid = IDS.assetA;
  const afterCloudReview = selectContext(ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096));
  assert.ok(!afterCloudReview.manifest.some((x) => x.asset_uid === rejectedUid));

  rmSync(root, { recursive: true, force: true });
});

// 11 ───────────────────────────────────────────────────────────────────────────────
test("sync: consent revoke is an unfiltered control event", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d, { pull_cursor: "sc1-old" });
    d.assets["synced-rel"] = localAsset("synced-rel", "synced relationship", "active", "synced", 1, 1);
    d.assets["local-only"] = localAsset("local-only", "local only fact", "active", "local_only", null, 1);
    d.assets["pending-1"] = localAsset("pending-1", "pending fact", "active", "pending_sync", null, 1);
    d.outbox["pending-1"] = proposeOp("pending-1", "pending fact");
  });

  const store = await openStore(root, "p1");
  await applyPullPage(store, WIRE.consent_revoked);
  await store.close();

  const snap = await readSnap(root);
  assert.equal(snap.consents[`${IDS.cloudDevice}:${IDS.soul}`].enabled, false, "the consent control event is applied, never filtered");
  assert.equal(snap.consents[`${IDS.cloudDevice}:${IDS.soul}`].revision, 2);
  assert.equal(snap.pull_cursor, "0", "consent revocation resets the pull cursor");
  assert.equal(snap.assets["synced-rel"], undefined, "the cloud-cached active asset is cleared");
  assert.ok(snap.assets["local-only"], "local originals are preserved");
  assert.ok(snap.assets["pending-1"], "unsynced local edits are preserved");
  assert.equal(snap.outbox["pending-1"], undefined, "pending sends stop");
  assert.equal(snap.quarantine["pending-1"]?.reason, "consent_revoked", "the pending send is parked, not sent");

  rmSync(root, { recursive: true, force: true });
});

// 12 ───────────────────────────────────────────────────────────────────────────────
test("sync: consent cursor reset happens once", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => baseChange(d, { pull_cursor: "sc1-old-valid" }));

  const consentRev2 = {
    cloud_device_uid: IDS.cloudDevice,
    soul_uid: IDS.soul,
    revision: 2,
    categories: ["identity", "relationship", "experience"],
    enabled: true,
  };

  const store = await openStore(root, "p1");
  await applyPullPage(store, {
    protocol: "soul-assets/v1",
    events: [{ event_uid: "c1", object_type: "consent", object: consentRev2 }],
    next_cursor: "sc2",
    has_more: false,
  });
  await store.close();
  assert.equal((await readSnap(root)).pull_cursor, "0", "the first higher consent revision resets the cursor");

  const store2 = await openStore(root, "p1");
  await applyPullPage(store2, {
    protocol: "soul-assets/v1",
    events: [{ event_uid: "c2", object_type: "consent", object: consentRev2 }],
    next_cursor: "sc3",
    has_more: false,
  });
  await store2.close();
  assert.equal((await readSnap(root)).pull_cursor, "sc3", "a replay of the same revision does not reset again");

  rmSync(root, { recursive: true, force: true });
});

// 13 ───────────────────────────────────────────────────────────────────────────────
test("sync: bootstrap preserves binding history dependencies", async () => {
  const root = tempDir();
  const b1 = "bind-op-1";
  const b2 = "bind-op-2";
  const stale = "stale-asset";
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: null, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active",
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes",
      soul_uid: IDS.soul, revision: 1, state: "bound",
      profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    d.outbox["reg"] = { operation_id: "reg", operation_kind: "register_soul", request: { soul_uid: IDS.soul, identity: { name: "Growth", description: "", character: "", greeting: "" }, consent_categories: [] }, predecessor_operation_ids: [] };
    d.outbox["consent"] = { operation_id: "consent", operation_kind: "consent", request: { soul_uid: IDS.soul, base_revision: 0, categories: ["identity", "relationship", "experience"], enabled: true }, predecessor_operation_ids: [] };
    d.outbox[b1] = { operation_id: b1, operation_kind: "binding", request: { base_revision: 0, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul, state: "bound" }, predecessor_operation_ids: [] };
    d.outbox[b2] = { operation_id: b2, operation_kind: "binding", request: { base_revision: 1, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul, state: "detached" }, predecessor_operation_ids: [b1] };
    d.assets[stale] = localAsset(stale, "stale fact");
    d.outbox[stale] = proposeOp(stale, "stale fact", { bindingRevision: 1 });
  });

  const order = [];
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/souls") {
      order.push("register_soul");
      return { status: 201, body: { soul: { soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1, identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active" }, consent: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 0, categories: [], enabled: false } } };
    }
    if (req.method === "PUT" && p.includes("/consent")) { order.push("consent"); return { status: 200, body: { consent: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: ["identity", "relationship", "experience"], enabled: true } } }; }
    if (req.method === "PUT" && p.includes("/bindings/")) {
      order.push(`binding:${req.body.state}:${req.body.base_revision}`);
      return { status: 200, body: { binding: { binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul, revision: req.body.base_revision + 1, state: req.body.state } } };
    }
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      order.push("push");
      return { status: 200, body: { protocol: "soul-assets/v1", results: [{ change_id: stale, status: "rejected", error: { code: "binding_stale" }, objects: [] }] } };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") { order.push("pull"); return { status: 200, body: emptyPull() }; }
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));

  assert.deepEqual(order, ["register_soul", "consent", "binding:bound:0", "binding:detached:1", "push", "pull"], "the bootstrap replays the binding history in dependency order");
  const snap = await readSnap(root);
  assert.equal(snap.quarantine[stale]?.reason, "binding_stale", "a model result frozen at the old binding revision is quarantined");
  assert.equal(Object.keys(snap.outbox).length, 0, "no automatic outbox item survives");
  assert.equal(snap.assets[stale].state, "candidate", "the stale asset never becomes active");

  rmSync(root, { recursive: true, force: true });
});

// 14 ───────────────────────────────────────────────────────────────────────────────
test("sync: cursor reset retains unsynced data", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d, { pull_cursor: "c1" });
    d.assets["local-only"] = localAsset("local-only", "local", "active", "local_only", null, 1);
    d.assets["pending-1"] = localAsset("pending-1", "pending", "active", "pending_sync", null, 1);
    d.assets["conflict-1"] = localAsset("conflict-1", "conflict", "active", "conflict", 1, 1);
    d.assets["synced-1"] = localAsset("synced-1", "synced", "active", "synced", 1, 1);
  });

  let pulls = 0;
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") {
      pulls += 1;
      if (pulls === 1) return { status: 409, body: { error: { code: "cursor_reset_required", retryable: true } } };
      return { status: 200, body: emptyPull() };
    }
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  const snap = await readSnap(root);

  assert.equal(snap.pull_cursor, "0", "409 cursor_reset_required resets the cursor");
  assert.equal(snap.assets["synced-1"], undefined, "cloud-confirmed cache is rebuilt from scratch");
  assert.ok(snap.assets["local-only"], "local_only is retained");
  assert.ok(snap.assets["conflict-1"], "conflict is retained");
  assert.ok(snap.assets["pending-1"], "pending_sync is retained");

  rmSync(root, { recursive: true, force: true });
});

// 15 ───────────────────────────────────────────────────────────────────────────────
test("sync: revoked device clears only downloaded private cache", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets["local-only"] = localAsset("local-only", "local", "active", "local_only", null, 1);
    d.assets["pending-1"] = localAsset("pending-1", "pending", "active", "pending_sync", null, 1);
    d.assets["synced-1"] = localAsset("synced-1", "synced", "active", "synced", 1, 1);
    d.outbox["pending-1"] = proposeOp("pending-1", "pending");
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      return { status: 401, body: { error: { code: "device_revoked", message: "this device was revoked", retryable: false } } };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 401, body: { error: { code: "device_revoked", message: "this device was revoked" } } };
    return { status: 500, body: {} };
  });

  const report = await syncOnce("p1", http, syncOpts(root));
  assert.match(report.error, /device_revoked/);

  const snap = await readSnap(root);
  assert.equal(snap.assets["synced-1"], undefined, "downloaded private cache is cleared");
  assert.ok(snap.assets["local-only"], "local-only survives");
  assert.ok(snap.assets["pending-1"], "unsynced local edits survive");
  assert.equal(snap.outbox["pending-1"], undefined, "revoked pending operations leave the sendable outbox");
  assert.equal(snap.quarantine["pending-1"].reason, "device_revoked", "they are parked for explicit recovery");
  assert.equal(snap.bindings[bindingKeyOf()].state, "detached", "the revoked device binding is no longer usable");

  rmSync(root, { recursive: true, force: true });
});

// 18 ───────────────────────────────────────────────────────────────────────────────
test("sync: publishing a soul never widens device consent", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "OwnerPrivateName", description: "private core", character: "", greeting: "" }, state: "active",
    };
    d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
      cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: ["identity"], enabled: true,
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul,
      revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    // A relationship asset the owner holds locally but never consented to sync.
    d.assets["rel-1"] = localAsset("rel-1", "owner relationship fact", "active", "local_only", null, 1);
    // A canary belonging to *another* soul, which must never leak into the owner's context.
    d.assets["canary"] = { ...localAsset("canary", "other soul fact"), soul_uid: "some-other-soul" };
  });

  const store = await openStore(root, "p1");
  await applyPullPage(store, {
    protocol: "soul-assets/v1",
    events: [
      {
        event_uid: "s1",
        object_type: "soul",
        object: {
          soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 2,
          identity: { name: "OwnerPrivateName", description: "private core v2", character: "", greeting: "" }, state: "active",
        },
      },
      {
        event_uid: "c1",
        object_type: "consent",
        object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: ["identity"], enabled: true },
      },
    ],
    next_cursor: "c-next",
    has_more: false,
  });
  await store.close();

  const snap = await readSnap(root);
  assert.deepEqual(snap.consents[`${IDS.cloudDevice}:${IDS.soul}`].categories, ["identity"], "publishing never widens consent categories");
  assert.equal(snap.souls[IDS.soul].identity.name, "OwnerPrivateName", "the owner private identity is stored, not a public projection");
  assert.equal("public_identity" in snap.souls[IDS.soul], false, "no public_identity field exists on the local Soul DTO");

  const input = ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096);
  assert.ok(input.assets.every((a) => a.soul_uid === IDS.soul), "other souls' assets never enter the owner's context input");

  rmSync(root, { recursive: true, force: true });
});

// 19 ───────────────────────────────────────────────────────────────────────────────
test("sync: same-length consent category swap revokes the removed category immediately", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active",
    };
    d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
      cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1,
      categories: ["identity", "relationship"], enabled: true,
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul,
      revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    d.assets["rel-1"] = localAsset("rel-1", "relationship fact", "active", "synced", 1, 1);
  });

  // ["identity","relationship"] → ["identity","experience"]: same length, but
  // "relationship" was replaced by "experience", so the relationship cache must go.
  const store = await openStore(root, "p1");
  await applyPullPage(store, {
    protocol: "soul-assets/v1",
    events: [{
      event_uid: "c1",
      object_type: "consent",
      object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: ["identity", "experience"], enabled: true },
    }],
    next_cursor: "c-swap",
    has_more: false,
  });
  await store.close();

  let snap = await readSnap(root);
  assert.equal(snap.assets["rel-1"], undefined, "a swapped-out category drops its synced asset");
  let input = ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096);
  assert.ok(!input.assets.some((a) => a.asset_uid === "rel-1"), "the removed category's asset is no longer injected");

  // Re-enabling relationship must not resurrect the deleted copy locally; only the
  // next pull can bring the cloud copy back.
  const store2 = await openStore(root, "p1");
  await applyPullPage(store2, {
    protocol: "soul-assets/v1",
    events: [{
      event_uid: "c2",
      object_type: "consent",
      object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 3, categories: ["identity", "relationship", "experience"], enabled: true },
    }],
    next_cursor: "c-reenable",
    has_more: false,
  });
  await store2.close();

  snap = await readSnap(root);
  assert.equal(snap.assets["rel-1"], undefined, "re-enabling consent does not resurrect the deleted asset locally");
  input = ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096);
  assert.ok(!input.assets.some((a) => a.asset_uid === "rel-1"), "no injection before the next pull delivers it");

  const store3 = await openStore(root, "p1");
  await applyPullPage(store3, {
    protocol: "soul-assets/v1",
    events: [{ event_uid: "c3", object_type: "asset", object: activeAsset("rel-1", "relationship fact") }],
    next_cursor: "c-pulled",
    has_more: false,
  });
  await store3.close();

  snap = await readSnap(root);
  input = ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096);
  assert.ok(input.assets.some((a) => a.asset_uid === "rel-1"), "the next pull restores the re-authorized asset for injection");

  rmSync(root, { recursive: true, force: true });
});

// 20 ───────────────────────────────────────────────────────────────────────────────
test("sync: enabling consent enqueues still-valid local_only assets exactly once", async () => {
  const root = tempDir();
  const assetUid = "40000000-0000-4000-8000-000000000099";
  const consentRev2 = { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: ["identity", "relationship"], enabled: true };
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active",
    };
    d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
      cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: ["identity"], enabled: true,
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul,
      revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    // Extracted while "relationship" was not authorized; the frozen extraction
    // provenance must survive until the category is re-enabled (R6).
    d.assets[assetUid] = {
      ...localAsset(assetUid, "local relationship fact", "active", "local_only", null, 1),
      binding_uid: IDS.binding,
      binding_revision: 1,
    };
    d.outbox["consent-op"] = {
      operation_id: "consent-op",
      operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 1, categories: ["identity", "relationship"], enabled: true },
      predecessor_operation_ids: [],
    };
  });

  const pushed = [];
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "PUT" && p.includes("/consent")) {
      return { status: 200, body: { consent: consentRev2, replay_from: "0" } };
    }
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      pushed.push(req.body.changes);
      return { status: 200, body: { protocol: "soul-assets/v1", results: req.body.changes.map((c) => acceptedResult(c.change_id, activeAsset(c.asset_uid, "local relationship fact"))) } };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  assert.equal(pushed.length, 1, "exactly one asset batch leaves the machine");
  assert.equal(pushed[0].length, 1, "exactly one propose is enqueued for the rescued local_only asset");
  assert.equal(pushed[0][0].change_id, assetUid, "the change_id is the stable UUID asset_uid");
  assert.equal(pushed[0][0].binding_uid, IDS.binding, "the frozen binding UID is preserved");
  assert.equal(pushed[0][0].binding_revision, 1, "the frozen binding revision is preserved");
  assert.equal(pushed[0][0].operation, "propose", "the rescued asset is proposed, not a control op");

  const snap1 = await readSnap(root);
  assert.equal(snap1.assets[assetUid].sync_state, "synced", "the rescued asset reached the server and is now synced");

  // Replay the same enable: the deterministic op id must not enqueue anything new.
  const store = await openStore(root, "p1");
  await store.transact((d) => {
    d.outbox["consent-op"] = {
      operation_id: "consent-op",
      operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 1, categories: ["identity", "relationship"], enabled: true },
      predecessor_operation_ids: [],
    };
  });
  await store.close();
  await syncOnce("p1", http, syncOpts(root));
  assert.equal(pushed.length, 1, "a replayed enable does not push a second asset op");

  rmSync(root, { recursive: true, force: true });
});

// 21 ───────────────────────────────────────────────────────────────────────────────
test("sync: 409 quarantine honors the server's real error code per endpoint", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.outbox["reg"] = {
      operation_id: "reg", operation_kind: "register_soul",
      request: { soul_uid: IDS.soul, identity: { name: "Growth", description: "", character: "", greeting: "" }, consent_categories: [] },
      predecessor_operation_ids: [],
    };
    d.outbox["consent-op"] = {
      operation_id: "consent-op", operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 1, categories: ["identity"], enabled: true },
      predecessor_operation_ids: [],
    };
    d.outbox["bind-op"] = {
      operation_id: "bind-op", operation_kind: "binding",
      request: { base_revision: 0, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul, state: "bound" },
      predecessor_operation_ids: [],
    };
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/souls") return { status: 409, body: { error: { code: "idempotency_mismatch", message: "same key, different body" } } };
    if (req.method === "PUT" && p.includes("/consent")) return { status: 409, body: { error: { code: "revision_conflict", message: "stale base_revision" } } };
    if (req.method === "PUT" && p.includes("/bindings/")) return { status: 409, body: { error: { code: "binding_conflict", message: "binding version mismatch" } } };
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  const report = await syncOnce("p1", http, syncOpts(root));
  assert.equal(report.error, undefined, "409 is a quarantine, not a fatal error");
  const snap = await readSnap(root);
  assert.equal(snap.quarantine["reg"]?.reason, "idempotency_mismatch", "register 409 quarantines under the server code");
  assert.equal(snap.quarantine["consent-op"]?.reason, "revision_conflict", "consent 409 quarantines under the server code");
  assert.equal(snap.quarantine["bind-op"]?.reason, "binding_conflict", "binding 409 quarantines under the server code");

  rmSync(root, { recursive: true, force: true });
});

// 22 ───────────────────────────────────────────────────────────────────────────────
test("sync: consent PUT replay_from resets the cursor once", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d, { pull_cursor: "c0" });
    d.outbox["consent-op"] = {
      operation_id: "consent-op",
      operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 1, categories: ["identity", "relationship"], enabled: true },
      predecessor_operation_ids: [],
    };
  });

  const consentRev2 = { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: ["identity", "relationship"], enabled: true };
  const pullCursors = [];
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "PUT" && p.includes("/consent")) return { status: 200, body: { consent: consentRev2, replay_from: "0" } };
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") {
      pullCursors.push(new URL(req.url).searchParams.get("cursor"));
      return { status: 200, body: { protocol: "soul-assets/v1", events: [], next_cursor: "c-after", has_more: false } };
    }
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  assert.equal(pullCursors[0], "0", "replay_from on a new consent revision resets the pull cursor to 0");

  // Re-send the same consent op: the server replays the same revision with
  // replay_from again — it must not reset a second time.
  const store = await openStore(root, "p1");
  await store.transact((d) => {
    d.outbox["consent-op"] = {
      operation_id: "consent-op",
      operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 1, categories: ["identity", "relationship"], enabled: true },
      predecessor_operation_ids: [],
    };
  });
  await store.close();
  await syncOnce("p1", http, syncOpts(root));
  assert.equal(pullCursors[1], "c-after", "a replayed same-revision consent response must not reset the cursor again");

  rmSync(root, { recursive: true, force: true });
});

// 23 ───────────────────────────────────────────────────────────────────────────────
test("sync: consent narrowing parks only removed-category sends", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d); // identity, relationship, experience — all authorized
    d.assets["rel-pending"] = localAsset("rel-pending", "relationship pending", "active", "pending_sync", null, 1);
    d.assets["exp-pending"] = { ...localAsset("exp-pending", "experience pending", "active", "pending_sync", null, 1), kind: "experience", trait: "style" };
    d.outbox["rel-pending"] = proposeOp("rel-pending", "relationship pending");
    const expOp = proposeOp("exp-pending", "experience pending");
    expOp.request.payload = { ...expOp.request.payload, kind: "experience", trait: "style" };
    d.outbox["exp-pending"] = expOp;
  });

  const store = await openStore(root, "p1");
  await applyPullPage(store, {
    protocol: "soul-assets/v1",
    events: [{
      event_uid: "c1",
      object_type: "consent",
      object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: ["identity", "experience"], enabled: true },
    }],
    next_cursor: "c-narrow",
    has_more: false,
  });
  await store.close();

  const snap = await readSnap(root);
  assert.equal(snap.outbox["rel-pending"], undefined, "the removed-category send is parked");
  assert.equal(snap.quarantine["rel-pending"]?.reason, "consent_revoked", "parked under consent_revoked");
  assert.ok(snap.outbox["exp-pending"], "the still-authorized send stays sendable");

  rmSync(root, { recursive: true, force: true });
});

// 24 ───────────────────────────────────────────────────────────────────────────────
test("sync: 429 honors Retry-After before retrying", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => baseChange(d));
  const delays = [];
  let pulls = 0;
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") {
      pulls += 1;
      if (pulls === 1) return { status: 429, headers: { "retry-after": "7" }, body: { error: { code: "rate_limited", retryable: true } } };
      return { status: 200, body: emptyPull() };
    }
    return { status: 500, body: {} };
  });
  await syncOnce("p1", http, { ...syncOpts(root), backoff: { maxRetries: 1, sleep: async (ms) => { delays.push(ms); } } });
  assert.equal(pulls, 2, "the 429 was retried once");
  assert.equal(delays[0], 7000, "Retry-After seconds are honored as the backoff delay");
  rmSync(root, { recursive: true, force: true });
});

// 25 ───────────────────────────────────────────────────────────────────────────────
test("sync: 5xx retries stop at the cap and report the error", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => baseChange(d));
  let pulls = 0;
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") { pulls += 1; return { status: 503, body: { error: { code: "unavailable", retryable: true } } }; }
    return { status: 500, body: {} };
  });
  const report = await syncOnce("p1", http, { ...syncOpts(root), backoff: { maxRetries: 2, sleep: async () => {} } });
  assert.equal(pulls, 3, "maxRetries=2 means one initial attempt plus two retries, then stop");
  assert.match(report.error, /unavailable/, "the last 5xx error is reported");
  rmSync(root, { recursive: true, force: true });
});

// 26 ───────────────────────────────────────────────────────────────────────────────
test("sync: 403 sync_not_authorized is surfaced", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => baseChange(d));
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 403, body: { error: { code: "sync_not_authorized", message: "this soul is not authorized for this device" } } };
    return { status: 500, body: {} };
  });
  const report = await syncOnce("p1", http, syncOpts(root));
  assert.equal(report.error, "sync_not_authorized", "403 surfaces the authorization code");
  rmSync(root, { recursive: true, force: true });
});

// 27 ───────────────────────────────────────────────────────────────────────────────
test("sync: 404, 413 and 422 surface their server error code", async () => {
  for (const [status, code] of [[404, "not_found"], [413, "payload_too_large"], [422, "validation_error"]]) {
    const root = tempDir();
    await seedProfile(root, "p1", "dev-1", (d) => baseChange(d));
    const http = fakeHttp((req) => {
      const p = pathnameOf(req.url);
      if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status, body: { error: { code, message: "boom" } } };
      return { status: 500, body: {} };
    });
    const report = await syncOnce("p1", http, syncOpts(root));
    assert.equal(report.error, code, `${status} surfaces ${code}`);
    rmSync(root, { recursive: true, force: true });
  }
});

// 28 ───────────────────────────────────────────────────────────────────────────────
test("sync: stale consent replay never re-enqueues a revoked category asset", async () => {
  const root = tempDir();
  const assetUid = "40000000-0000-4000-8000-000000000099";
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active",
    };
    d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
      cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 3,
      categories: ["identity", "experience"], enabled: true,
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul,
      revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    // "relationship" was removed from the current consent; a stale consent that once
    // listed it must not pull this local_only asset back into the outbox.
    d.assets[assetUid] = localAsset(assetUid, "local relationship fact", "active", "local_only", null, 1);
  });

  const store = await openStore(root, "p1");
  await applyPullPage(store, {
    protocol: "soul-assets/v1",
    events: [{
      event_uid: "stale",
      object_type: "consent",
      object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: ["identity", "relationship"], enabled: true },
    }],
    next_cursor: "c-stale",
    has_more: false,
  });
  await store.close();

  const snap = await readSnap(root);
  assert.equal(snap.consents[`${IDS.cloudDevice}:${IDS.soul}`].revision, 3, "the stale lower revision never rolls back the current consent");
  assert.equal(snap.assets[assetUid].sync_state, "local_only", "the revoked category's local_only asset stays local_only");
  assert.equal(Object.keys(snap.outbox).length, 0, "no op is enqueued by a stale consent replay");

  rmSync(root, { recursive: true, force: true });
});

// 29 ───────────────────────────────────────────────────────────────────────────────
test("sync: consent enable never enqueues a cloud-dismissed digest", async () => {
  const root = tempDir();
  const assetUid = "local-only-dismissed";
  const DISMISSED = "the person deleted this fact elsewhere";
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active",
    };
    d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
      cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: ["identity"], enabled: true,
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul,
      revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    d.assets[assetUid] = localAsset(assetUid, DISMISSED, "active", "local_only", null, 1);
    // The cloud already dismissed this exact digest from another device.
    d.digest_tombstones[IDS.soul] = [{
      asset_uid: "cloud-dismissed-uid",
      soul_uid: IDS.soul,
      kind: "relationship",
      trait: "preference",
      content_digest: contentDigest(DISMISSED),
      revision: 1,
      state: "deleted",
      restored_by_uid: null,
    }];
  });

  const store = await openStore(root, "p1");
  await applyPullPage(store, {
    protocol: "soul-assets/v1",
    events: [{
      event_uid: "enable",
      object_type: "consent",
      object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: ["identity", "relationship"], enabled: true },
    }],
    next_cursor: "c-enable",
    has_more: false,
  });
  await store.close();

  const snap = await readSnap(root);
  assert.equal(snap.assets[assetUid].sync_state, "local_only", "a cloud-dismissed digest stays local_only");
  assert.equal(Object.keys(snap.outbox).length, 0, "no propose is enqueued for a dismissed digest");

  rmSync(root, { recursive: true, force: true });
});

// 30 ───────────────────────────────────────────────────────────────────────────────
test("sync: first-sight consent replay_from resets the cursor once", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active",
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul,
      revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    d.pull_cursor = "c0";
    // No prior consent: the first consent PUT response is first-sight.
    d.outbox["consent-op"] = {
      operation_id: "consent-op",
      operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 0, categories: ["identity", "relationship"], enabled: true },
      predecessor_operation_ids: [],
    };
  });

  const consentRev1 = { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: ["identity", "relationship"], enabled: true };
  const pullCursors = [];
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "PUT" && p.includes("/consent")) return { status: 200, body: { consent: consentRev1, replay_from: "0" } };
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") {
      pullCursors.push(new URL(req.url).searchParams.get("cursor"));
      return { status: 200, body: { protocol: "soul-assets/v1", events: [], next_cursor: "c-after", has_more: false } };
    }
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, syncOpts(root));
  assert.equal(pullCursors[0], "0", "a first-sight consent carrying replay_from resets the cursor to 0");

  const store = await openStore(root, "p1");
  await store.transact((d) => {
    d.outbox["consent-op"] = {
      operation_id: "consent-op",
      operation_kind: "consent",
      request: { soul_uid: IDS.soul, base_revision: 0, categories: ["identity", "relationship"], enabled: true },
      predecessor_operation_ids: [],
    };
  });
  await store.close();
  await syncOnce("p1", http, syncOpts(root));
  assert.equal(pullCursors[1], "c-after", "a same-revision replay does not reset the cursor again");

  rmSync(root, { recursive: true, force: true });
});

// 23 ───────────────────────────────────────────────────────────────────────────────
test("sync: an internal store failure surfaces a code, never an absolute path", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.outbox["reg"] = {
      operation_id: "reg",
      operation_kind: "register_soul",
      request: { soul_uid: IDS.soul, identity: { name: "Growth", description: "", character: "", greeting: "" }, consent_categories: [] },
      predecessor_operation_ids: [],
    };
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/souls") return { status: 201, body: { soul: { soul_uid: IDS.soul } } };
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });

  // The store's atomic commit writes the snapshot through fs.writeFile; a failure
  // there must surface as the typed StoreError code, never its (path-bearing) message.
  const brokenFs = {
    ...defaultStoreFs,
    writeFile: async () => {
      throw new StoreError("repair_required", "/home/user/.37soul/profiles/p1/snapshot.json is unreadable");
    },
  };

  const report = await syncOnce("p1", http, { ...syncOpts(root), fs: brokenFs });
  assert.equal(report.error, "repair_required", "a store failure is reported as its typed code");
  assert.ok(!JSON.stringify(report).includes("/"), "no path segment (no '/') leaks into the report");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R4/R9: revocation and quarantine semantics
// ---------------------------------------------------------------------------

test("R4: revoking identity stops injecting a downloaded cloud identity", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "CLOUD_IDENTITY_CANARY", description: "private cloud", character: "", greeting: "" },
      state: "active", origin: "cloud",
    };
    d.assets[IDS.assetA] = localAsset(IDS.assetA, "cloud relationship", "active", "synced", 1, 1);
  });
  const store = await openStore(root, "p1");
  try {
    const before = await store.read();
    const bundle = selectContext(ownerContextInput(before, IDS.soul, before.bindings[bindingKeyOf()], "task", 4096));
    assert.match(bundle.rendered_text, /CLOUD_IDENTITY_CANARY/);

    await applyPullPage(store, {
      protocol: "soul-assets/v1",
      events: [{
        event_uid: "revoke-identity",
        object_type: "consent",
        object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: [], enabled: false },
      }],
      next_cursor: "c-revoked",
      has_more: false,
    });
    const after = await store.read();
    assert.equal(after.souls[IDS.soul], undefined, "downloaded cloud identity is removed");
    assert.throws(
      () => ownerContextInput(after, IDS.soul, after.bindings[bindingKeyOf()], "task", 4096),
      (error) => error?.code === "identity_not_authorized",
      "a revoked identity is never injected again",
    );
    assert.equal(after.assets[IDS.assetA], undefined, "removed identity/relationship cache is gone");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R4: a local original Soul survives identity revocation and remains injectable", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: null, identity_revision: 1,
      identity: { name: "LOCAL_ORIGINAL", description: "local", character: "", greeting: "" },
      state: "active", origin: "local",
      local_identity: { name: "LOCAL_ORIGINAL", description: "local", character: "", greeting: "" },
    };
    d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
      cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: [], enabled: false,
    };
    d.assets["local-only"] = localAsset("local-only", "local fact", "active", "local_only", null, 1);
  });
  const store = await openStore(root, "p1");
  try {
    const snap = await store.read();
    const input = ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096);
    assert.equal(input.soul.identity.name, "LOCAL_ORIGINAL");
    assert.ok(input.assets.some((asset) => asset.asset_uid === "local-only"), "local original asset survives offline");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R4: device_revoked removes scoped credentials and parks pending work", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets["pending"] = localAsset("pending", "pending", "active", "pending_sync", null, 1);
    d.outbox["pending"] = proposeOp("pending", "pending");
  });
  writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({
      api_base_url: "https://fake.test",
      machine_id: "m1",
      tokens: {},
      credentials: [{
        token: "scoped-token", owner_id: IDS.owner, cloud_device_uid: IDS.cloudDevice,
        runtime_kind: "hermes", profile_id: "p1", obtained_at: "x",
      }],
    })}\n`,
    { mode: 0o600 },
  );
  const http = fakeHttp(() => ({ status: 401, body: { error: { code: "device_revoked", message: "revoked" } } }));
  const report = await syncOnce("p1", http, { root, baseUrl: "https://fake.test", backoff: { sleep: async () => {}, maxRetries: 0 } });
  assert.equal(report.error, "device_revoked");
  const config = JSON.parse(readFileSync(path.join(root, "config.json"), "utf8"));
  assert.deepEqual(config.credentials, [], "revoked device credentials cannot be reused");
  const snap = await readSnap(root);
  assert.equal(snap.outbox["pending"], undefined);
  assert.equal(snap.quarantine["pending"].reason, "device_revoked");
  rmSync(root, { recursive: true, force: true });
});

test("R7: a same-revision cloud detach beats an unconfirmed local rev2", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    const key = bindingKeyOf();
    d.bindings[key] = {
      ...d.bindings[key],
      revision: 2,
      cloud_revision: 1,
      unconfirmed: true,
    };
  });
  const store = await openStore(root, "p1");
  try {
    await applyPullPage(store, {
      protocol: "soul-assets/v1",
      events: [{
        event_uid: "cloud-detach",
        object_type: "binding",
        object: {
          binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes",
          soul_uid: IDS.soul, revision: 2, state: "detached",
        },
      }],
      next_cursor: "c-detached",
      has_more: false,
    });
    const snap = await store.read();
    const binding = snap.bindings[bindingKeyOf()];
    assert.equal(binding.state, "detached", "the confirmed cloud detach is respected");
    assert.equal(binding.cloud_revision, 2);
    assert.equal(binding.unconfirmed, false);
    assert.equal(snap.pull_cursor, "c-detached");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R9: a quarantined old edit does not hide the confirmed cloud copy", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.assets[IDS.assetA] = localAsset(IDS.assetA, "cloud current", "active", "synced", 2, 2);
    d.quarantine["old-edit"] = {
      operation: {
        operation_id: "old-edit", operation_kind: "asset",
        request: { change_id: "old-edit", operation: "review", soul_uid: IDS.soul, asset_uid: IDS.assetA, payload: { action: "edit" } },
        predecessor_operation_ids: [],
      },
      reason: "revision_conflict",
    };
  });
  const store = await openStore(root, "p1");
  try {
    const snap = await store.read();
    const input = ownerContextInput(snap, IDS.soul, snap.bindings[bindingKeyOf()], "task", 4096);
    assert.ok(input.assets.some((asset) => asset.asset_uid === IDS.assetA), "the confirmed cloud copy is eligible");
    assert.ok(!input.quarantinedAssetUids?.includes(IDS.assetA), "the old conflict does not exclude it");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7: 409 push followed by Pull respects the cloud detach and keeps local conflict", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    const key = bindingKeyOf();
    d.bindings[key] = { ...d.bindings[key], revision: 2, cloud_revision: 1, unconfirmed: true };
    d.outbox["local-bind"] = {
      operation_id: "local-bind", operation_kind: "binding",
      request: { base_revision: 1, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul, state: "detached" },
      predecessor_operation_ids: [],
    };
  });

  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "PUT" && p.includes("/bindings/")) {
      return { status: 409, body: { error: { code: "revision_conflict", message: "conflict", retryable: false, current_revision: 2 } } };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") {
      return {
        status: 200,
        body: {
          protocol: "soul-assets/v1",
          events: [{
            event_uid: "cloud-detach", object_type: "binding",
            object: {
              binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes",
              soul_uid: IDS.soul, revision: 2, state: "detached",
            },
          }],
          next_cursor: "c-after-conflict",
          has_more: false,
        },
      };
    }
    return { status: 500, body: {} };
  });

  const report = await syncOnce("p1", http, syncOpts(root));
  assert.equal(report.error, undefined);
  const snap = await readSnap(root);
  assert.equal(snap.bindings[bindingKeyOf()].state, "detached", "the confirmed cloud detach wins");
  assert.equal(snap.bindings[bindingKeyOf()].cloud_revision, 2);
  assert.equal(snap.bindings[bindingKeyOf()].unconfirmed, false);
  assert.ok(snap.quarantine["local-bind"], "the local proposal stays available as a conflict");
  assert.equal(snap.pull_cursor, "c-after-conflict");
  rmSync(root, { recursive: true, force: true });
});

test("R6: re-authorization never sends an asset whose frozen binding is gone", async () => {
  const root = tempDir();
  const assetUid = "40000000-0000-4000-8000-000000000098";
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: 7, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active", origin: "local",
      local_identity: { name: "Growth", description: "", character: "", greeting: "" },
    };
    d.consents[`${IDS.cloudDevice}:${IDS.soul}`] = {
      cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: ["identity"], enabled: true,
    };
    d.bindings[bindingKeyOf()] = {
      binding_uid: IDS.binding, session_ref: IDS.session, runtime_kind: "hermes", soul_uid: IDS.soul,
      revision: 1, state: "detached", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    d.assets[assetUid] = {
      ...localAsset(assetUid, "orphan relationship", "active", "local_only", null, 1),
      binding_uid: IDS.binding,
      binding_revision: 1,
    };
  });
  const store = await openStore(root, "p1");
  try {
    await applyPullPage(store, {
      protocol: "soul-assets/v1",
      events: [{
        event_uid: "enable-relationship", object_type: "consent",
        object: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 2, categories: ["identity", "relationship"], enabled: true },
      }],
      next_cursor: "c-enabled",
      has_more: false,
    });
    const snap = await store.read();
    assert.equal(snap.outbox[assetUid], undefined, "a stale frozen binding is not sent");
    assert.equal(snap.quarantine[`local-binding:${assetUid}`].reason, "binding_stale");
    assert.equal(snap.assets[assetUid].sync_state, "conflict");
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2: registration carries explicit categories; an old empty registration is parked", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: null, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" },
      state: "active", origin: "local",
      local_identity: { name: "Growth", description: "", character: "", greeting: "" },
    };
    d.outbox["register"] = {
      operation_id: "register", operation_kind: "register_soul",
      request: {
        soul_uid: IDS.soul,
        identity: { name: "Growth", description: "", character: "", greeting: "" },
        consent_categories: ["identity", "relationship"],
      },
      predecessor_operation_ids: [],
    };
  });
  let registered = null;
  const http = fakeHttp((req) => {
    const p = pathnameOf(req.url);
    if (req.method === "POST" && p.endsWith("/souls")) {
      registered = req.body;
      if (!req.body.consent_categories?.includes("identity")) {
        return { status: 422, body: { error: { code: "invalid_payload", message: "identity consent is required" } } };
      }
      return {
        status: 201,
        body: {
          protocol: "soul-assets/v1",
          soul: { soul_uid: IDS.soul, legacy_host_id: 42, identity_revision: 1, identity: req.body.identity, state: "active" },
          consent: { cloud_device_uid: IDS.cloudDevice, soul_uid: IDS.soul, revision: 1, categories: req.body.consent_categories, enabled: true },
        },
      };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") return { status: 200, body: emptyPull() };
    return { status: 500, body: {} };
  });
  const report = await syncOnce("p1", http, syncOpts(root));
  assert.equal(report.error, undefined);
  assert.deepEqual(registered.consent_categories, ["identity", "relationship"]);
  const snap = await readSnap(root);
  assert.equal(snap.souls[IDS.soul].legacy_host_id, 42);
  assert.equal(snap.consents[`${IDS.cloudDevice}:${IDS.soul}`].categories.length, 2);
  rmSync(root, { recursive: true, force: true });

  const oldRoot = tempDir();
  await seedProfile(oldRoot, "p1", "dev-1", (d) => {
    d.owner_id = IDS.owner;
    d.cloud_device_uid = IDS.cloudDevice;
    d.souls[IDS.soul] = {
      soul_uid: IDS.soul, legacy_host_id: null, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" }, state: "active", origin: "local",
    };
    d.outbox["old-register"] = {
      operation_id: "old-register", operation_kind: "register_soul",
      request: { soul_uid: IDS.soul, identity: { name: "Growth", description: "", character: "", greeting: "" }, consent_categories: [] },
      predecessor_operation_ids: [],
    };
  });
  const oldHttp = fakeHttp((req) => {
    if (req.method === "POST" && pathnameOf(req.url).endsWith("/souls")) {
      return { status: 422, body: { error: { code: "invalid_payload", message: "identity consent is required" } } };
    }
    return { status: 200, body: emptyPull() };
  });
  await syncOnce("p1", oldHttp, syncOpts(oldRoot));
  const oldSnap = await readSnap(oldRoot);
  assert.equal(oldSnap.outbox["old-register"], undefined);
  assert.equal(oldSnap.quarantine["old-register"].reason, "authorization_required");
  rmSync(oldRoot, { recursive: true, force: true });
});

test("F1: an unauthorized local Soul binding never blocks an authorized Soul", async () => {
  const root = tempDir();
  const unauthorizedSoul = "soul-local-only";
  const authorizedSoul = IDS.soul;
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    d.souls[unauthorizedSoul] = {
      soul_uid: unauthorizedSoul, legacy_host_id: null, identity_revision: 1,
      identity: { name: "Local", description: "", character: "", greeting: "" },
      state: "active", origin: "local",
      local_identity: { name: "Local", description: "", character: "", greeting: "" },
    };
    d.outbox["local-binding"] = {
      operation_id: "local-binding", operation_kind: "binding",
      request: { base_revision: 0, session_ref: "local-session", runtime_kind: "hermes", soul_uid: unauthorizedSoul, state: "bound" },
      predecessor_operation_ids: [],
    };
    d.assets[IDS.assetA] = localAsset(IDS.assetA, "authorized fact");
    d.outbox[IDS.assetA] = proposeOp(IDS.assetA, "authorized fact");
  });
  const calls = [];
  const http = fakeHttp((req) => {
    calls.push(`${req.method} ${pathnameOf(req.url)}`);
    if (req.method === "POST" && pathnameOf(req.url).endsWith("/push")) {
      return {
        status: 200,
        body: {
          protocol: "soul-assets/v1",
          results: req.body.changes.map((change) => acceptedResult(change.change_id, activeAsset(change.asset_uid, "authorized fact"))),
        },
      };
    }
    return { status: 200, body: emptyPull("cursor-after") };
  });
  const report = await syncOnce("p1", http, syncOpts(root));
  assert.equal(report.error, undefined);
  assert.ok(calls.some((call) => call.includes("/push")), "authorized asset was pushed");
  assert.ok(calls.some((call) => call.startsWith("GET")), "Pull ran for the authorized Soul");
  assert.ok(!calls.some((call) => call.includes("local-binding")), "the unauthorized binding never left the machine");
  const snap = await readSnap(root);
  assert.ok(snap.outbox["local-binding"], "the local binding history is retained");
  assert.ok(snap.bindings[["p1", "dev-1", "hermes", "ns-1"].join("\u0000")], "the authorized binding still works");
  rmSync(root, { recursive: true, force: true });
});

test("F2: an earlier bind ACK cannot overwrite a newer queued detach", async () => {
  const root = tempDir();
  const key = bindingKeyOf();
  await seedProfile(root, "p1", "dev-1", (d) => {
    baseChange(d);
    delete d.bindings[key];
  });
  const nativeKey = { profile_id: "p1", device_id: "dev-1", runtime_kind: "hermes", native_session_id: "ns-1" };
  await selectSoul(nativeKey, IDS.soul, { root });
  await detachBinding(nativeKey, { root });
  const actualBinding = Object.values((await readSnap(root)).bindings)[0];
  let calls = 0;
  const http = async (url, init = {}) => {
    calls += 1;
    const p = pathnameOf(String(url));
    if (init.method === "PUT" && p.includes("/bindings/")) {
      const body = JSON.parse(String(init.body));
      if (body.state === "bound") {
        return makeResponse({
          status: 200,
          body: { protocol: "soul-assets/v1", binding: { binding_uid: actualBinding.binding_uid, session_ref: actualBinding.session_ref, runtime_kind: "hermes", soul_uid: IDS.soul, revision: 1, state: "bound" } },
        });
      }
      throw new Error("network down before detach ACK");
    }
    return makeResponse({ status: 200, body: emptyPull() });
  };
  const report = await syncOnce("p1", http, { ...syncOpts(root), backoff: { sleep: async () => {}, maxRetries: 0 } });
  assert.equal(report.error, "sync_failed");
  const snap = await readSnap(root);
  const binding = Object.values(snap.bindings).find((candidate) => candidate.soul_uid === IDS.soul);
  assert.equal(binding.state, "detached", "the queued detach remains the current intent");
  assert.equal(binding.revision, 2);
  assert.equal(binding.cloud_revision, 1, "the earlier ACK advances only the confirmed watermark");
  assert.equal(binding.unconfirmed, true);
  assert.ok(Object.values(snap.outbox).some((op) => op.operation_kind === "binding" && op.request.state === "detached"), "the detach stays queued for retry");
  assert.equal(await resolveBinding(nativeKey, undefined, { root }), null, "ordinary resolution stays detached");
  await assert.rejects(
    () => assertBindingCurrent(nativeKey, actualBinding.binding_uid, 1, { root }),
    (error) => error?.code === "stale_binding",
    "an old rev1 extraction cannot pass the current-revision check",
  );
  rmSync(root, { recursive: true, force: true });
});
