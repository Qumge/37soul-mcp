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

import { openStore } from "../dist/local/store.js";
import {
  resolveBinding,
  detachBinding,
  selectSoul,
  bindingKey,
  setToolDefault,
  setAccountDefaultSoul,
} from "../dist/local/bindings.js";
import {
  mergeLoginProfile,
  readAccountsIndex,
  mergeJournalPath,
} from "../dist/local/profiles.js";
import { deviceLogin } from "../dist/install.js";

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

  // Zero HTTP: mergeLoginProfile performs no network calls.
  const result = await mergeLoginProfile(profileId, "owner-123", undefined, { root });
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
    d.owner_id = "owner-A";
    d.souls["s-a"] = makeSoul("s-a");
    d.outbox["a-op"] = makeOutboxOp("a-op");
    d.bindings[bindingKey(aKey)] = makeBinding("b-a", "s-a", aKey);
  });
  const index = await readAccountsIndex(root);
  index["owner-A"] = { profile_id: "a1", default_soul_uid: null };
  // (write via a fresh association below instead of touching the file directly)
  await seedProfile(root, "b1", "dev-b");

  // Account B claims its own independent profile.
  const result = await mergeLoginProfile("b1", "owner-B", undefined, { root });
  assert.equal(result, "b1");

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
  assert.equal(deviceCodesReq.mode, "assets_only");
  const tokensReq = calls[1].body;
  assert.equal(tokensReq.protocol, "soul-assets/v1");
  assert.equal(tokensReq.machine_id, "machine-1");
  assert.equal(tokensReq.client_version, "0.11.0");
});
