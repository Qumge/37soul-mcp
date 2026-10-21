#!/usr/bin/env node
/**
 * Task 3: offline Souls, anonymous-profile login merge and versioned session
 * bindings, on top of the Task 2 single-writer transactional store.
 *
 * The six named tests from the brief are written first and must fail for the
 * right reason (the modules do not exist yet), then turn green once the
 * implementation lands. Everything runs against temp homes via explicit `root`
 * arguments — no real HOME, no network, no installed agents.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename as fsRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openStore, acquireWriterLock } from "../dist/local/store.js";
import { startWriter, sendWriter } from "../dist/local/writer.js";
import {
  resolveBinding,
  detachBinding,
  selectSoul,
  bindingKey,
  setToolDefault,
  setAccountDefaultSoul,
  assertBindingCurrent,
} from "../dist/local/bindings.js";
import {
  mergeLoginProfile,
  readAccountsIndex,
  writeAccountsIndex,
  accountsIndexPath,
  mergeJournalPath,
  resolveLocalHostIdSync,
} from "../dist/local/profiles.js";
import { deviceLogin } from "../dist/install.js";
import { loginCommand, bindCommand } from "../dist/cli.js";
import { configureSyncHttp } from "../dist/sync/client.js";

function tempDir(prefix = "profiles-bindings-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSoul(uid, name = "Growth") {
  return {
    soul_uid: uid,
    legacy_host_id: null,
    identity_revision: 1,
    identity: { name, description: "", character: "", greeting: "" },
    state: "active",
  };
}

function makeBinding(uid, soulUid, key) {
  return {
    binding_uid: uid,
    session_ref: `session-ref-${uid}`,
    runtime_kind: key.runtime_kind,
    soul_uid: soulUid,
    revision: 1,
    state: "bound",
    profile_id: key.profile_id,
    device_id: key.device_id,
    native_session_id: key.native_session_id,
  };
}

function makeOutboxOp(opId, kind = "asset") {
  return {
    operation_id: opId,
    operation_kind: kind,
    request: { change_id: opId, operation: "propose" },
    predecessor_operation_ids: [],
  };
}

/** Pin device.json first so the store keeps one stable device_id across reopens. */
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

const keyOf = (profileId, deviceId, runtimeKind, nativeSessionId) => ({
  profile_id: profileId,
  device_id: deviceId,
  runtime_kind: runtimeKind,
  native_session_id: nativeSessionId,
});

// ---------------------------------------------------------------------------
// profiles: anonymous association keeps profile and soul ids
// ---------------------------------------------------------------------------

test("profiles: anonymous association keeps profile and soul ids", async () => {
  const root = tempDir();
  const profileId = "anon-1";
  const soulUid = "soul-1";
  await seedProfile(root, profileId, "device-anon-1", (d) => {
    d.souls[soulUid] = makeSoul(soulUid);
    d.outbox["op-1"] = makeOutboxOp("op-1");
  });
  const beforeStore = await openStore(root, profileId);
  const beforeLogin = await beforeStore.read();
  await beforeStore.close();

  // Zero HTTP: mergeLoginProfile performs no network calls. Assert with a recording
  // stub, not a comment — any fetch during association fails the test.
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    throw new Error("mergeLoginProfile must never perform HTTP");
  };
  let result;
  try {
    result = await mergeLoginProfile(profileId, "owner-123", undefined, { root });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls.length, 0, "anonymous association is fully local");
  assert.equal(result, profileId);

  const afterStore = await openStore(root, profileId);
  const afterLogin = await afterStore.read();
  await afterStore.close();

  assert.equal(afterLogin.profile_id, beforeLogin.profile_id);
  assert.equal(afterLogin.souls[soulUid].soul_uid, beforeLogin.souls[soulUid].soul_uid);
  assert.deepEqual(afterLogin.outbox, beforeLogin.outbox);
  assert.equal(afterLogin.device_id, beforeLogin.device_id);
  assert.equal(afterLogin.owner_id, "owner-123");

  const index = await readAccountsIndex(root);
  assert.equal(index["owner-123"].profile_id, profileId);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// profiles: same owner merge is crash safe
// ---------------------------------------------------------------------------

test("profiles: same owner merge is crash safe", async () => {
  const root = tempDir();
  const targetId = "target-1";
  const sourceId = "source-1";
  const sourceKey = keyOf(sourceId, "dev-source", "hermes", "ns-src");

  await seedProfile(root, targetId, "dev-target", (d) => {
    d.souls["soul-a"] = makeSoul("soul-a", "Growth");
    d.outbox["t-op"] = makeOutboxOp("t-op");
  });
  // The pre-existing same-owner profile (a previous login on another device).
  await seedProfile(root, sourceId, "dev-source", (d) => {
    d.owner_id = "owner-123";
    d.souls["soul-b"] = makeSoul("soul-b", "Growth"); // same name, different UID
    d.bindings[bindingKey(sourceKey)] = makeBinding("b-src", "soul-b", sourceKey);
    d.outbox["s-op"] = makeOutboxOp("s-op");
    d.quarantine["q-1"] = { operation: makeOutboxOp("q-op"), reason: "conflict" };
  });

  // Inject a mid-merge interruption: crash on the 2nd snapshot commit.
  let renameCount = 0;
  const crashingFs = {
    rename: async (from, to) => {
      if (to.endsWith("snapshot.json") && !to.endsWith("snapshot.json.bak")) {
        renameCount += 1;
        if (renameCount === 2) {
          const err = new Error("simulated crash mid-merge");
          err.code = "EIO";
          throw err;
        }
      }
      return fsRename(from, to);
    },
  };

  await assert.rejects(
    () => mergeLoginProfile(targetId, "owner-123", sourceId, { root, fs: crashingFs }),
    /simulated crash mid-merge/,
  );
  assert.equal(renameCount, 2, "the crash injection actually fired");

  const journal = JSON.parse(readFileSync(mergeJournalPath(root, targetId), "utf8"));
  assert.ok(journal.completed.includes("souls"), "first step committed and journaled");
  assert.ok(!journal.completed.includes("bindings"), "crash landed before the bindings step");

  // Restart: the same call must finish the merge without loss.
  const result = await mergeLoginProfile(targetId, "owner-123", sourceId, { root });
  assert.equal(result, targetId);

  const mergedStore = await openStore(root, targetId);
  const merged = await mergedStore.read();
  await mergedStore.close();

  // Same name, different UID -> not merged; both Souls preserved.
  assert.ok(merged.souls["soul-a"], "target soul preserved");
  assert.ok(merged.souls["soul-b"], "source soul copied under its own UID");
  assert.equal(Object.keys(merged.souls).length, 2);
  // pending / conflict / native mappings all survive.
  assert.ok(merged.outbox["t-op"] && merged.outbox["s-op"], "pending outbox items preserved");
  assert.ok(merged.quarantine["q-1"], "conflicted operations preserved");
  assert.ok(merged.bindings[bindingKey(sourceKey)], "native binding mapping preserved");

  // The source profile is kept intact.
  const sourceAfterStore = await openStore(root, sourceId);
  const sourceAfter = await sourceAfterStore.read();
  await sourceAfterStore.close();
  assert.ok(sourceAfter.souls["soul-b"], "source profile kept intact");
  assert.equal(sourceAfter.owner_id, "owner-123");

  const index = await readAccountsIndex(root);
  assert.equal(index["owner-123"].profile_id, targetId, "accounts index switched to the merged target");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// profiles: switching accounts never mixes data
// ---------------------------------------------------------------------------

test("profiles: switching accounts never mixes data", async () => {
  const root = tempDir();
  const aKey = keyOf("a1", "dev-a", "hermes", "ns-a");
  await seedProfile(root, "a1", "dev-a", (d) => {
    d.souls["s-a"] = makeSoul("s-a");
    d.outbox["a-op"] = makeOutboxOp("a-op");
    d.bindings[bindingKey(aKey)] = makeBinding("b-a", "s-a", aKey);
  });
  // Associate owner A for real (writes accounts.json on disk), not an in-memory index.
  await mergeLoginProfile("a1", "owner-A", undefined, { root });
  await seedProfile(root, "b1", "dev-b");

  // Account B claims its own independent profile.
  const result = await mergeLoginProfile("b1", "owner-B", undefined, { root });
  assert.equal(result, "b1");

  // The on-disk accounts index maps each owner to a distinct profile.
  const onDiskIndex = JSON.parse(readFileSync(accountsIndexPath(root), "utf8"));
  assert.equal(onDiskIndex["owner-A"].profile_id, "a1");
  assert.equal(onDiskIndex["owner-B"].profile_id, "b1");
  assert.notEqual(onDiskIndex["owner-A"].profile_id, onDiskIndex["owner-B"].profile_id);

  const bStore = await openStore(root, "b1");
  const bSnap = await bStore.read();
  await bStore.close();
  assert.deepEqual(bSnap.souls, {}, "B never sees A's souls");
  assert.deepEqual(bSnap.bindings, {}, "B never sees A's native bindings");
  assert.deepEqual(bSnap.outbox, {}, "B never sees A's pending outbox");

  const aStore = await openStore(root, "a1");
  const aSnap = await aStore.read();
  await aStore.close();
  assert.ok(aSnap.souls["s-a"], "A's data is untouched");

  // A profile already owned by A cannot be re-attached to B.
  await assert.rejects(
    () => mergeLoginProfile("a1", "owner-B", undefined, { root }),
    (err) => err && err.code === "owner_mismatch",
  );

  // A's native session still resolves to A's Soul; B's identical native id does not.
  const aResolved = await resolveBinding(aKey, undefined, { root });
  assert.equal(aResolved.soul_uid, "s-a");
  const bResolved = await resolveBinding(keyOf("b1", "dev-b", "hermes", "ns-a"), undefined, { root });
  assert.equal(bResolved, null);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// binding: concurrent native sessions stay isolated
// ---------------------------------------------------------------------------

test("binding: concurrent native sessions stay isolated", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });
  const key1 = keyOf("p1", "dev-1", "hermes", "ns-1");
  const key2 = keyOf("p1", "dev-1", "hermes", "ns-2");

  await selectSoul(key1, "s1", { root });
  await selectSoul(key2, "s2", { root });

  // Alternating reads and writes never cross.
  const b1 = await resolveBinding(key1, undefined, { root });
  const b2 = await resolveBinding(key2, undefined, { root });
  assert.equal(b1.soul_uid, "s1");
  assert.equal(b2.soul_uid, "s2");

  await detachBinding(key1, { root });
  const after1 = await resolveBinding(key1, undefined, { root });
  const after2 = await resolveBinding(key2, undefined, { root });
  assert.equal(after1, null, "detaching one session does not affect the other");
  assert.equal(after2.soul_uid, "s2");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// binding: injected switch requires new session
// ---------------------------------------------------------------------------

test("binding: injected switch requires new session", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });
  const key1 = keyOf("p1", "dev-1", "hermes", "ns-1");

  const bound = await selectSoul(key1, "s1", { root });
  assert.equal(bound.revision, 1);

  // Mark the session as injected (a receipt at stage "injected").
  const mark = await openStore(root, "p1");
  await mark.transact((d) => {
    d.receipts["r1"] = {
      binding_uid: bound.binding_uid,
      binding_revision: bound.revision,
      stage: "injected",
      manifest: [],
      rendered_sha256: "sha",
    };
  });
  await mark.close();

  const switched = await selectSoul(key1, "s2", { root });
  assert.deepEqual(switched, { error: "needs_new_session" });

  const snapStore = await openStore(root, "p1");
  const snap = await snapStore.read();
  await snapStore.close();
  assert.equal(snap.bindings[bindingKey(key1)].soul_uid, "s1", "original binding unchanged");
  assert.equal(snap.bindings[bindingKey(key1)].state, "bound");

  // Un-injected session may switch: same binding record, bumped revision.
  const key2 = keyOf("p1", "dev-1", "hermes", "ns-2");
  const b2 = await selectSoul(key2, "s1", { root });
  const sw2 = await selectSoul(key2, "s2", { root });
  assert.equal(sw2.soul_uid, "s2");
  assert.equal(sw2.revision, 2, "switch increments the binding revision");
  assert.equal(sw2.binding_uid, b2.binding_uid, "switch mutates the same record, not a new one");

  // Detach increments revision, and a late result against the old revision is refused.
  const key3 = keyOf("p1", "dev-1", "hermes", "ns-3");
  const b3 = await selectSoul(key3, "s1", { root });
  assert.equal(b3.revision, 1);
  const detached = await detachBinding(key3, { root });
  assert.equal(detached.state, "detached");
  assert.equal(detached.revision, 2);
  assert.equal(await resolveBinding(key3, undefined, { root }), null, "a detached session no longer resolves");

  // assertBindingCurrent (Task 4 will call it before committing results): the current
  // revision is accepted; a stale / detached / other-profile binding is refused.
  await assertBindingCurrent(key2, sw2.binding_uid, 2, { root }); // current switch revision
  await assert.rejects(
    () => assertBindingCurrent(key2, sw2.binding_uid, 1, { root }),
    (err) => err && err.code === "stale_binding",
    "a result frozen before the switch is refused",
  );
  await assert.rejects(
    () => assertBindingCurrent(key3, b3.binding_uid, 1, { root }),
    (err) => err && err.code === "stale_binding",
    "a result frozen before the detach is refused",
  );
  await assert.rejects(
    () => assertBindingCurrent(key3, detached.binding_uid, 2, { root }),
    (err) => err && err.code === "stale_binding",
    "a detached binding never accepts a result",
  );
  await assertBindingCurrent(key1, bound.binding_uid, 1, { root }); // injected session untouched

  // Account switch: a binding uid from profile p1 is unknown in a different profile.
  await seedProfile(root, "p2", "dev-2", (d) => {
    d.souls["s3"] = makeSoul("s3");
  });
  await assert.rejects(
    () => assertBindingCurrent(keyOf("p2", "dev-2", "hermes", "ns-9"), sw2.binding_uid, 2, { root }),
    (err) => err && err.code === "unknown_binding",
    "a binding uid from another profile is refused",
  );
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// binding: offline revision two replays both operations
// ---------------------------------------------------------------------------

test("binding: offline revision two replays both operations", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");

  const bound = await selectSoul(key, "s1", { root }); // base 0 -> revision 1
  assert.equal(bound.revision, 1);
  const detached = await detachBinding(key, { root }); // base 1 -> revision 2
  assert.equal(detached.revision, 2);

  const store = await openStore(root, "p1");
  const snap = await store.read();
  await store.close();

  const bindingOps = Object.values(snap.outbox)
    .filter((o) => o.operation_kind === "binding")
    .sort((a, b) => a.request.base_revision - b.request.base_revision);

  assert.equal(bindingOps.length, 2, "two immutable operations, never flattened into one");
  const [op1, op2] = bindingOps;
  assert.equal(op1.request.base_revision, 0);
  assert.equal(op1.request.state, "bound");
  assert.equal(op1.request.soul_uid, "s1");
  assert.deepEqual(op1.predecessor_operation_ids, []);
  assert.equal(op2.request.base_revision, 1);
  assert.equal(op2.request.state, "detached");
  assert.deepEqual(op2.predecessor_operation_ids, [op1.operation_id]);
  // The frozen model request is preserved, not rewritten: same session_ref throughout.
  assert.equal(op1.request.session_ref, op2.request.session_ref);
  assert.ok(op1.request.session_ref && op1.request.session_ref !== key.native_session_id);

  assert.equal(snap.bindings[bindingKey(key)].revision, 2, "binding frozen at revision 2");
  assert.equal(snap.bindings[bindingKey(key)].state, "detached");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolution order: explicit > native > tool > account > unique; refuse to guess
// ---------------------------------------------------------------------------

test("binding: resolution order follows explicit > native > tool > account > unique", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");

  // Session explicit choice wins over every default.
  const explicit = await resolveBinding(key, "s2", { root });
  assert.equal(explicit.soul_uid, "s2");

  // Tool default wins when there is no explicit choice and no native binding.
  await setToolDefault({ profile_id: "p1", runtime_kind: "hermes" }, "s1", { root });
  const tool = await resolveBinding(keyOf("p1", "dev-1", "hermes", "ns-2"), undefined, { root });
  assert.equal(tool.soul_uid, "s1");

  // Account default applies to a runtime without its own tool default.
  await setAccountDefaultSoul("p1", "s2", { root });
  const acct = await resolveBinding(keyOf("p1", "dev-1", "codex", "ns-3"), undefined, { root });
  assert.equal(acct.soul_uid, "s2");

  // Unique Soul is chosen when nothing else is set.
  await seedProfile(root, "p2", "dev-2", (d) => {
    d.souls["only"] = makeSoul("only");
  });
  const unique = await resolveBinding(keyOf("p2", "dev-2", "hermes", "ns-u"), undefined, { root });
  assert.equal(unique.soul_uid, "only");

  // Multiple Souls and no default: refuse to guess (never cwd/title/character name).
  await seedProfile(root, "p3", "dev-3", (d) => {
    d.souls["a"] = makeSoul("a");
    d.souls["b"] = makeSoul("b");
  });
  const refused = await resolveBinding(keyOf("p3", "dev-3", "hermes", "ns-r"), undefined, { root });
  assert.equal(refused, null);

  // No native id: refuse to guess even when a unique Soul exists.
  const noNative = await resolveBinding(keyOf("p2", "dev-2", "hermes", ""), undefined, { root });
  assert.equal(noNative, null);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// deviceLogin carries the soul-assets/v1 fields
// ---------------------------------------------------------------------------

test("login: deviceLogin sends and parses soul-assets/v1 fields", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/api/v1/cli/device_codes")) {
      return {
        status: 201,
        ok: true,
        async json() {
          return { device_code: "dc", user_code: "UC", verification_url: "https://app.test/approve", interval: 1, expires_in: 600 };
        },
      };
    }
    return {
      status: 201,
      ok: true,
      async json() {
        return {
          protocol: "soul-assets/v1",
          mode: "assets_only",
          owner_id: "123",
          cloud_device_uid: "50000000-0000-4000-8000-000000000001",
          default_soul_uid: null,
          tokens: [{ agent_kind: "hermes", token: "TOKEN-HERMES" }],
        };
      },
    };
  };

  const deps = {
    home: "/tmp/37soul-login-home",
    apiBase: "https://app.test",
    fetch: fetchImpl,
    platform: "linux",
    openBrowser: false,
    now: () => 0,
    sleep: async () => {},
  };

  const result = await deviceLogin(deps, ["hermes"], {
    assetsMode: true,
    machineId: "machine-1",
    clientVersion: "0.11.0",
  });

  assert.equal(result.protocol, "soul-assets/v1");
  assert.equal(result.mode, "assets_only");
  assert.equal(result.owner_id, "123");
  assert.equal(result.cloud_device_uid, "50000000-0000-4000-8000-000000000001");
  assert.equal(result.default_soul_uid, null);
  assert.deepEqual(result.tokens, { hermes: "TOKEN-HERMES" });

  const deviceCodesReq = calls[0].body;
  assert.equal(deviceCodesReq.protocol, "soul-assets/v1");
  assert.equal(deviceCodesReq.machine_id, "machine-1");
  assert.equal(deviceCodesReq.client_version, "0.11.0");
  assert.ok(!("mode" in deviceCodesReq), "mode is response-only, never sent in the request");
  const tokensReq = calls[1].body;
  assert.equal(tokensReq.protocol, "soul-assets/v1");
  assert.equal(tokensReq.machine_id, "machine-1");
  assert.equal(tokensReq.client_version, "0.11.0");
  assert.ok(!("mode" in tokensReq), "mode is response-only, never sent in the request");
});

// ---------------------------------------------------------------------------
// fix 1: the session explicit choice outranks an existing native binding
// ---------------------------------------------------------------------------

test("binding: explicit choice outranks a native binding (non-injected re-points, injected refuses)", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["A"] = makeSoul("A");
    d.souls["B"] = makeSoul("B");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");

  // Bind the native session to A.
  const bound = await selectSoul(key, "A", { root });
  assert.equal(bound.soul_uid, "A");
  assert.equal(bound.revision, 1);

  // Explicit B, non-injected -> re-pointed through the same revision-bump/CAS path.
  const rePointed = await resolveBinding(key, "B", { root });
  assert.equal(rePointed.soul_uid, "B");
  assert.equal(rePointed.revision, 2, "explicit choice bumps the revision");
  assert.equal(rePointed.binding_uid, bound.binding_uid, "same record, not a new binding");

  // Inject the (now B) binding, then an explicit A must refuse WITHOUT touching it.
  const mark = await openStore(root, "p1");
  await mark.transact((d) => {
    d.receipts["r1"] = {
      binding_uid: rePointed.binding_uid,
      binding_revision: rePointed.revision,
      stage: "injected",
      manifest: [],
      rendered_sha256: "sha",
    };
  });
  await mark.close();

  const injected = await resolveBinding(key, "A", { root });
  assert.equal(injected, null, "explicit switch of an injected session is refused");

  const snapStore = await openStore(root, "p1");
  const snap = await snapStore.read();
  await snapStore.close();
  assert.equal(snap.bindings[bindingKey(key)].soul_uid, "B", "stored binding is untouched");
  assert.equal(snap.bindings[bindingKey(key)].revision, 2, "stored revision is untouched");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fix 5: an unknown explicit UID never falls through to defaults
// ---------------------------------------------------------------------------

test("binding: unknown explicit soul never falls through to defaults", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  await setToolDefault({ profile_id: "p1", runtime_kind: "hermes" }, "s1", { root });
  await setAccountDefaultSoul("p1", "s1", { root });

  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const result = await resolveBinding(key, "ghost", { root });
  assert.equal(result, null, "unknown explicit UID returns null, never consults defaults");

  // And nothing was auto-bound on the way.
  const store = await openStore(root, "p1");
  const snap = await store.read();
  await store.close();
  assert.deepEqual(snap.bindings, {}, "no binding was created for an unknown explicit UID");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fix 6: the host-id local peek is gated on soul_sync_mode === "assets_only"
// ---------------------------------------------------------------------------

test("resolveHostId: local peek is gated on assets mode", () => {
  const root = tempDir();
  const profileId = "p1";
  mkdirSync(path.join(root, "profiles", profileId), { recursive: true });
  writeFileSync(
    path.join(root, "profiles", profileId, "device.json"),
    `${JSON.stringify({ device_id: "dev-1" })}\n`,
    { mode: 0o600 },
  );
  const s1 = makeSoul("s1");
  s1.legacy_host_id = 42;
  writeFileSync(
    path.join(root, "profiles", profileId, "snapshot.json"),
    `${JSON.stringify({ store_version: 1, profile_id: profileId, souls: { s1 } })}\n`,
    { mode: 0o600 },
  );

  // No gate at all (accounts.json missing) -> env/default path, no local host id.
  assert.equal(resolveLocalHostIdSync(root), null, "no gate -> null");

  // Gate present but not assets mode -> still null.
  writeFileSync(
    accountsIndexPath(root),
    `${JSON.stringify({ "owner-1": { profile_id: profileId, default_soul_uid: null, soul_sync_mode: null } })}\n`,
    { mode: 0o600 },
  );
  assert.equal(resolveLocalHostIdSync(root), null, "non-assets gate -> null");

  // Gate present in assets mode -> the local host id.
  writeFileSync(
    accountsIndexPath(root),
    `${JSON.stringify({ "owner-1": { profile_id: profileId, default_soul_uid: null, soul_sync_mode: "assets_only" } })}\n`,
    { mode: 0o600 },
  );
  assert.equal(resolveLocalHostIdSync(root), 42, "assets gate -> local host id");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fix 2: login association runs inside the single writer; never from the CLI
// ---------------------------------------------------------------------------

test("login: association runs inside the writer and persists soul_sync_mode", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const writer = await startWriter(root);
  try {
    const request = (requestUid, ownerId) => ({
      request_uid: requestUid,
      profile_id: "p1",
      command: "login_associate",
      payload: { owner_id: ownerId, cloud_device_uid: "cdu-1", default_soul_uid: "s1", mode: "assets_only" },
    });
    // Two concurrent associations serialize through the writer's dispatch queue.
    const [r1, r2] = await Promise.all([
      sendWriter(root, request("u1", "owner-1")),
      sendWriter(root, request("u2", "owner-1")),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);

    const store = await openStore(root, "p1");
    const snap = await store.read();
    await store.close();
    assert.equal(snap.owner_id, "owner-1");
    assert.equal(snap.cloud_device_uid, "cdu-1");

    const onDisk = JSON.parse(readFileSync(accountsIndexPath(root), "utf8"));
    assert.equal(onDisk["owner-1"].profile_id, "p1");
    assert.equal(onDisk["owner-1"].soul_sync_mode, "assets_only");
  } finally {
    await writer.close();
  }
  rmSync(root, { recursive: true, force: true });
});

test("login: refused when no writer can be acquired — the CLI never commits directly", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  // Hold the writer lock so the CLI's startWriter fallback cannot acquire it.
  const releaseLock = await acquireWriterLock(root);
  try {
    const fetchImpl = async (url) => {
      const s = String(url);
      if (s.endsWith("/api/v1/cli/device_codes")) {
        return {
          status: 201,
          ok: true,
          async json() {
            return { device_code: "dc", user_code: "UC", verification_url: "https://x", interval: 1, expires_in: 600 };
          },
        };
      }
      return {
        status: 201,
        ok: true,
        async json() {
          return {
            protocol: "soul-assets/v1",
            mode: "assets_only",
            owner_id: "123",
            cloud_device_uid: "cdu",
            default_soul_uid: null,
            tokens: [{ agent_kind: "hermes", token: "T" }],
          };
        },
      };
    };
    const deps = {
      home: "/tmp/x",
      apiBase: "https://x",
      fetch: fetchImpl,
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      nodePath: process.execPath,
      cliScriptPath: "/tmp/cli.js",
      agentdScriptPath: "/tmp/cli.js",
      platform: "linux",
      openBrowser: false,
      now: () => 0,
      sleep: async () => {},
    };
    const io = { stdout: () => {}, stderr: () => {}, stdin: async () => "" };

    const code = await loginCommand(root, ["--profile", "p1"], io, deps);
    assert.equal(code, 1, "login must be refused when it cannot go through the writer");

    const store = await openStore(root, "p1");
    const snap = await store.read();
    await store.close();
    assert.equal(snap.owner_id, null, "the CLI process never commits the snapshot directly");
  } finally {
    await releaseLock();
  }
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fix round 2: login requires an explicit profile choice when a same-owner
// profile already exists; bind surfaces needs_new_session
// ---------------------------------------------------------------------------

function makeLoginDeps(ownerId = "owner-123", { cloudDeviceUid = "cdu", defaultSoulUid = null } = {}) {
  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.endsWith("/api/v1/cli/device_codes")) {
      return {
        status: 201,
        ok: true,
        async json() {
          return { device_code: "dc", user_code: "UC", verification_url: "https://x", interval: 1, expires_in: 600 };
        },
      };
    }
    return {
      status: 201,
      ok: true,
      async json() {
        return {
          protocol: "soul-assets/v1",
          mode: "assets_only",
          owner_id: ownerId,
          cloud_device_uid: cloudDeviceUid,
          default_soul_uid: defaultSoulUid,
          tokens: [{ agent_kind: "hermes", token: "T" }],
        };
      },
    };
  };
  return {
    home: "/tmp/x",
    apiBase: "https://x",
    fetch: fetchImpl,
    runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    nodePath: process.execPath,
    cliScriptPath: "/tmp/cli.js",
    agentdScriptPath: "/tmp/cli.js",
    platform: "linux",
    openBrowser: false,
    now: () => 0,
    sleep: async () => {},
  };
}

function capturingIO() {
  let text = "";
  return {
    io: {
      stdout: (t) => {
        text += t;
      },
      stderr: (t) => {
        text += t;
      },
      stdin: async () => "",
    },
    text: () => text,
  };
}

test("login: same-owner candidate without a flag is refused, nothing changes", async () => {
  const root = tempDir();
  await seedProfile(root, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
    d.outbox["op-anon"] = makeOutboxOp("op-anon");
  });
  await seedProfile(root, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-123";
    d.souls["s-old"] = makeSoul("s-old");
    d.outbox["op-old"] = makeOutboxOp("op-old");
    d.quarantine["q-old"] = { operation: makeOutboxOp("q-op"), reason: "conflict" };
  });

  const { io, text } = capturingIO();
  const code = await loginCommand(root, ["--profile", "anon"], io, makeLoginDeps("owner-123"));
  assert.equal(code, 1, "login without an explicit choice exits non-zero");
  assert.match(text(), /existing/, "the candidate is listed");
  assert.match(text(), /--merge-profile/, "the rerun instruction names --merge-profile");
  assert.match(text(), /--use-profile/, "the rerun instruction names --use-profile");

  // No snapshot/index change happened.
  const anonStore = await openStore(root, "anon");
  const anon = await anonStore.read();
  await anonStore.close();
  assert.equal(anon.owner_id, null, "the anonymous profile is not silently associated");
  const index = await readAccountsIndex(root);
  assert.equal(index["owner-123"], undefined, "the account index is not silently switched");
  rmSync(root, { recursive: true, force: true });
});

test("login: --merge-profile merges into the current profile, source kept", async () => {
  const root = tempDir();
  await seedProfile(root, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
    d.outbox["op-anon"] = makeOutboxOp("op-anon");
  });
  await seedProfile(root, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-123";
    d.souls["s-old"] = makeSoul("s-old");
    d.outbox["op-old"] = makeOutboxOp("op-old");
    d.quarantine["q-old"] = { operation: makeOutboxOp("q-op"), reason: "conflict" };
  });

  const { io } = capturingIO();
  const code = await loginCommand(
    root,
    ["--profile", "anon", "--merge-profile", "existing"],
    io,
    makeLoginDeps("owner-123"),
  );
  assert.equal(code, 0);

  const anonStore = await openStore(root, "anon");
  const anon = await anonStore.read();
  await anonStore.close();
  assert.equal(anon.owner_id, "owner-123");
  assert.ok(anon.souls["s-anon"] && anon.souls["s-old"], "both sides' UIDs are kept");
  assert.ok(anon.outbox["op-anon"] && anon.outbox["op-old"], "pending items from both sides survive");
  assert.ok(anon.quarantine["q-old"], "conflicted items survive the merge");

  const existingStore = await openStore(root, "existing");
  const existing = await existingStore.read();
  await existingStore.close();
  assert.ok(existing.souls["s-old"], "the source profile is kept intact");

  const index = await readAccountsIndex(root);
  assert.equal(index["owner-123"].profile_id, "anon", "index switched to the merged target last");
  rmSync(root, { recursive: true, force: true });
});

test("login: --use-profile switches the index, anonymous profile untouched", async () => {
  const root = tempDir();
  await seedProfile(root, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
  });
  await seedProfile(root, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-123";
    d.souls["s-old"] = makeSoul("s-old");
  });

  const { io } = capturingIO();
  const code = await loginCommand(
    root,
    ["--profile", "anon", "--use-profile", "existing"],
    io,
    makeLoginDeps("owner-123"),
  );
  assert.equal(code, 0);

  const index = await readAccountsIndex(root);
  assert.equal(index["owner-123"].profile_id, "existing", "index points at the existing profile");

  const anonStore = await openStore(root, "anon");
  const anon = await anonStore.read();
  await anonStore.close();
  assert.equal(anon.owner_id, null, "the anonymous profile is untouched");
  assert.deepEqual(Object.keys(anon.souls), ["s-anon"], "the anonymous profile's souls are untouched");

  const existingStore = await openStore(root, "existing");
  const existing = await existingStore.read();
  await existingStore.close();
  assert.equal(existing.owner_id, "owner-123");
  assert.ok(existing.souls["s-old"], "the existing profile is untouched");
  rmSync(root, { recursive: true, force: true });
});

test("bind: an injected session surfaces needs_new_session as a real error", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  const bound = await selectSoul(key, "s1", { root });
  const mark = await openStore(root, "p1");
  await mark.transact((d) => {
    d.receipts["r1"] = {
      binding_uid: bound.binding_uid,
      binding_revision: bound.revision,
      stage: "injected",
      manifest: [],
      rendered_sha256: "sha",
    };
  });
  await mark.close();

  const { io, text } = capturingIO();
  const code = await bindCommand(root, ["--profile", "p1", "--soul", "s2", "--session", "ns-1"], io, false);
  assert.equal(code, 1, "bind on an injected session exits non-zero");
  assert.match(text(), /new session/, "the user sees a real message");
  assert.ok(!text().includes("undefined"), "never prints undefined");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fix round 3: --use-profile applies the login identity; success line prints
// the adopted profile
// ---------------------------------------------------------------------------

test("login: --use-profile persists the fresh cloud_device_uid and prints the adopted profile", async () => {
  const root = tempDir();
  await seedProfile(root, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
  });
  await seedProfile(root, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-123";
    d.souls["s-old"] = makeSoul("s-old");
  });

  const { io, text } = capturingIO();
  const code = await loginCommand(
    root,
    ["--profile", "anon", "--use-profile", "existing"],
    io,
    makeLoginDeps("owner-123", { cloudDeviceUid: "cdu-xyz" }),
  );
  assert.equal(code, 0);

  const existingStore = await openStore(root, "existing");
  const existing = await existingStore.read();
  await existingStore.close();
  assert.equal(existing.cloud_device_uid, "cdu-xyz", "fresh cloud_device_uid persisted in the adopted snapshot");

  assert.match(text(), /profile existing/, "the success line prints the adopted profile, not the anonymous one");
  rmSync(root, { recursive: true, force: true });
});

test("login: --use-profile refuses a conflicting cloud device, writing nothing", async () => {
  const root = tempDir();
  await seedProfile(root, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
  });
  await seedProfile(root, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-123";
    d.souls["s-old"] = makeSoul("s-old");
    d.cloud_device_uid = "cdu-old";
  });

  const { io, text } = capturingIO();
  const code = await loginCommand(
    root,
    ["--profile", "anon", "--use-profile", "existing"],
    io,
    makeLoginDeps("owner-123", { cloudDeviceUid: "cdu-new" }),
  );
  assert.equal(code, 1, "a conflicting cloud device is refused");
  assert.match(text(), /device_mismatch|cloud device/, "the refusal is typed and user-visible");

  const existingStore = await openStore(root, "existing");
  const existing = await existingStore.read();
  await existingStore.close();
  assert.equal(existing.cloud_device_uid, "cdu-old", "the adopted snapshot is untouched");

  const index = await readAccountsIndex(root);
  assert.equal(index["owner-123"], undefined, "the account index is not switched");
  rmSync(root, { recursive: true, force: true });
});

test("login: --use-profile applies a known default soul", async () => {
  const root = tempDir();
  await seedProfile(root, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
  });
  await seedProfile(root, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-123";
    d.souls["s-old"] = makeSoul("s-old");
    d.souls["s2"] = makeSoul("s2");
  });

  const { io } = capturingIO();
  const code = await loginCommand(
    root,
    ["--profile", "anon", "--use-profile", "existing"],
    io,
    makeLoginDeps("owner-123", { defaultSoulUid: "s2" }),
  );
  assert.equal(code, 0);

  const resolved = await resolveBinding(keyOf("existing", "dev-existing", "hermes", "ns-new"), undefined, { root });
  assert.equal(resolved.soul_uid, "s2", "a known default is applied via defaults.json");
  rmSync(root, { recursive: true, force: true });
});

test("login: --use-profile leaves resolution untouched when the default is absent or unknown", async () => {
  // Absent default -> no account default installed; two souls => refuse to guess.
  const root1 = tempDir();
  await seedProfile(root1, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
  });
  await seedProfile(root1, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-1";
    d.souls["s-a"] = makeSoul("s-a");
    d.souls["s-b"] = makeSoul("s-b");
  });
  {
    const { io } = capturingIO();
    const code = await loginCommand(root1, ["--profile", "anon", "--use-profile", "existing"], io, makeLoginDeps("owner-1"));
    assert.equal(code, 0);
    const resolved = await resolveBinding(keyOf("existing", "dev-existing", "hermes", "ns-new"), undefined, { root: root1 });
    assert.equal(resolved, null, "absent default leaves resolution untouched");
  }
  rmSync(root1, { recursive: true, force: true });

  // Unknown default -> same: nothing installed.
  const root2 = tempDir();
  await seedProfile(root2, "anon", "dev-anon", (d) => {
    d.souls["s-anon"] = makeSoul("s-anon");
  });
  await seedProfile(root2, "existing", "dev-existing", (d) => {
    d.owner_id = "owner-2";
    d.souls["s-a"] = makeSoul("s-a");
    d.souls["s-b"] = makeSoul("s-b");
  });
  {
    const { io } = capturingIO();
    const code = await loginCommand(root2, ["--profile", "anon", "--use-profile", "existing"], io, makeLoginDeps("owner-2", { defaultSoulUid: "ghost" }));
    assert.equal(code, 0);
    const resolved = await resolveBinding(keyOf("existing", "dev-existing", "hermes", "ns-new"), undefined, { root: root2 });
    assert.equal(resolved, null, "unknown default leaves resolution untouched");
  }
  rmSync(root2, { recursive: true, force: true });
});

// R8: detach is an explicit user intent; ordinary lifecycle resolution must not
// silently recreate a binding through defaults or the unique-Soul path.
test("P2-1: an authorized predecessor chain still allows a legal same-session switch", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
    d.souls["A"] = makeSoul("A");
    d.souls["B"] = makeSoul("B");
    d.consents["cdu-1:A"] = {
      cloud_device_uid: "cdu-1", soul_uid: "A", revision: 1,
      categories: ["identity"], enabled: true,
    };
    d.consents["cdu-1:B"] = {
      cloud_device_uid: "cdu-1", soul_uid: "B", revision: 1,
      categories: ["identity"], enabled: true,
    };
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-authorized");
  const a = await selectSoul(key, "A", { root });
  const b = await selectSoul(key, "B", { root });
  assert.equal(b.soul_uid, "B");
  assert.equal(b.revision, a.revision + 1, "the authorized predecessor chain permits the switch");
  const again = await selectSoul(key, "B", { root });
  assert.equal(again.binding_uid, b.binding_uid);
  assert.equal(again.revision, b.revision);
  rmSync(root, { recursive: true, force: true });
});

test("P2-2: same-Soul selection stays idempotent after injection", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
    d.souls["B"] = makeSoul("B");
    d.consents["cdu-1:B"] = {
      cloud_device_uid: "cdu-1", soul_uid: "B", revision: 1,
      categories: ["identity", "relationship", "experience"], enabled: true,
    };
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-legal");
  const first = await selectSoul(key, "B", { root });
  const store = await openStore(root, "p1");
  await store.transact((d) => {
    const binding = d.bindings[bindingKey(key)];
    binding.cloud_revision = 1;
    binding.unconfirmed = false;
    for (const [id, op] of Object.entries(d.outbox)) {
      if (op.operation_kind === "binding") delete d.outbox[id];
    }
    d.receipts["r-injected"] = {
      binding_uid: binding.binding_uid,
      binding_revision: binding.revision,
      stage: "injected",
      manifest: [],
      rendered_sha256: "sha",
    };
  });
  await store.close();

  const again = await selectSoul(key, "B", { root });
  assert.equal(again.binding_uid, first.binding_uid, "same binding UID");
  assert.equal(again.revision, first.revision, "no revision bump");
  assert.equal(again.soul_uid, "B");
  const explicit = await resolveBinding(key, "B", { root });
  assert.equal(explicit.binding_uid, first.binding_uid, "explicit same-Soul resolve still injects");
  const implicit = await resolveBinding(key, undefined, { root });
  assert.equal(implicit.binding_uid, first.binding_uid, "implicit same-Soul resolve still injects");

  const after = await openStore(root, "p1");
  const snap = await after.read();
  await after.close();
  assert.ok(
    !Object.values(snap.outbox).some((op) => op.operation_kind === "binding"),
    "idempotent selection creates no new operation",
  );
  assert.equal(snap.bindings[bindingKey(key)].revision, first.revision);

  // A different Soul on the injected session remains a new-session error.
  const other = await openStore(root, "p1");
  await other.transact((d) => { d.souls["C"] = makeSoul("C"); });
  await other.close();
  assert.deepEqual(await selectSoul(key, "C", { root }), { error: "needs_new_session" });
  assert.equal(await resolveBinding(key, "C", { root }), null);
  rmSync(root, { recursive: true, force: true });
});

test("P2: an unconfirmed unauthorized switch cannot enqueue the authorized target", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
    d.souls["A"] = makeSoul("A");
    d.souls["B"] = makeSoul("B");
    // The user ran `soul authorize B` but has not synced it yet.
    d.outbox["register-B"] = {
      operation_id: "register-B",
      operation_kind: "register_soul",
      request: { soul_uid: "B", identity: makeSoul("B").identity, consent_categories: ["identity"] },
      predecessor_operation_ids: [],
    };
  });
  const key = keyOf("p1", "dev-1", "hermes", "same-session");
  const a = await selectSoul(key, "A", { root });
  assert.equal(a.revision, 1);

  const refused = await selectSoul(key, "B", { root });
  assert.deepEqual(refused, { error: "needs_new_session" });

  const store = await openStore(root, "p1");
  const snap = await store.read();
  await store.close();
  assert.equal(snap.bindings[bindingKey(key)].soul_uid, "A", "the local A binding is preserved");
  assert.ok(
    !Object.values(snap.outbox).some((op) => op.operation_kind === "binding" && op.request.soul_uid === "B"),
    "no invalid base_revision=1 B operation is queued",
  );

  // Following the prompt with a new native session creates a legal B binding at base 0.
  const freshKey = keyOf("p1", "dev-1", "hermes", "new-session");
  const b = await selectSoul(freshKey, "B", { root });
  assert.equal(b.soul_uid, "B");
  assert.equal(b.revision, 1);
  rmSync(root, { recursive: true, force: true });
});

test("R8: detach survives ordinary resolution and only explicit selection rebinds", async () => {
  const root = tempDir();
  const profileId = "p1";
  const key = keyOf(profileId, "dev-1", "hermes", "ns-1");
  await seedProfile(root, profileId, "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const first = await resolveBinding(key, undefined, { root });
  assert.ok(first, "the unique Soul creates the first binding");
  const detached = await detachBinding(key, { root });
  assert.equal(detached.state, "detached");

  assert.equal(await resolveBinding(key, undefined, { root }), null, "ordinary resolution respects detach");
  const explicit = await selectSoul(key, "s1", { root });
  assert.equal(explicit.binding_uid, detached.binding_uid, "explicit selection reuses the same record");
  assert.equal(explicit.state, "bound");
  assert.equal(explicit.revision, detached.revision + 1);
  rmSync(root, { recursive: true, force: true });
});


test("login: a selected website Soul is downloaded and becomes the account default", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1");
  const soul = makeSoul("s-cloud", "Restored Soul");
  const asset = {
    asset_uid: "a-cloud", soul_uid: "s-cloud", kind: "relationship", trait: "preference",
    content: "RESTORED_FACT", applicability: "", tags: [], evidence: "explicit_user_statement",
    verification: "unverified", sensitivity: "normal", state: "active", revision: 1,
    supersedes_uid: null, pinned: false,
    source: { runtime_kind: "hermes", session_ref: "s", event_ref: "e", occurred_at: "2026-10-21T00:00:00Z" },
  };
  configureSyncHttp(async (url) => {
    const body = new URL(String(url)).pathname === "/api/v1/me/soul_sync/pull"
      ? {
          protocol: "soul-assets/v1",
          events: [
            { event_uid: "e-consent", object_type: "consent", object: { cloud_device_uid: "cdu", soul_uid: "s-cloud", revision: 1, categories: ["identity", "relationship", "experience"], enabled: true } },
            { event_uid: "e-soul", object_type: "soul", object: soul },
            { event_uid: "e-asset", object_type: "asset", object: asset },
          ],
          next_cursor: null,
          has_more: false,
        }
      : {};
    const status = body.protocol ? 200 : 500;
    return {
      status,
      ok: status === 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });

  try {
    const { io, text } = capturingIO();
    const code = await loginCommand(root, ["--profile", "p1"], io, makeLoginDeps("owner-1", { defaultSoulUid: "s-cloud" }));
    assert.equal(code, 0);

    const index = await readAccountsIndex(root);
    assert.equal(index["owner-1"].default_soul_uid, "s-cloud");
    const store = await openStore(root, "p1");
    const snap = await store.read();
    await store.close();
    assert.ok(snap.souls["s-cloud"], text());
    assert.equal(snap.souls["s-cloud"].identity.name, "Restored Soul");
    assert.equal(snap.assets["a-cloud"].content, "RESTORED_FACT");
    assert.match(text(), /Soul restored: Restored Soul/);
  } finally {
    configureSyncHttp(null);
    rmSync(root, { recursive: true, force: true });
  }
});
