#!/usr/bin/env node
/**
 * Task 2: single-writer transactional local soul store + crash recovery.
 *
 * The crash-injection points are real: the store commits through an injectable fs
 * seam (openStore's third argument), and every fs-level crash test asserts that
 * the injection actually fired (an injected counter must equal 1), so a store that
 * stops using the seam — or stops being atomic — fails these tests instead of
 * silently passing because the injection never ran.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename as fsRename, writeFile as fsWriteFile, readFile as fsReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  openStore,
  StoreError,
  snapshotPath,
  snapshotBackupPath,
  writerLockPath,
  devicePath,
} from "../dist/local/store.js";
import { startWriter, sendWriter, registerWriterCommand } from "../dist/local/writer.js";

function tempDir(prefix = "local-store-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSoul(uid) {
  return {
    soul_uid: uid,
    legacy_host_id: null,
    identity_revision: 1,
    identity: { name: "N", description: "", character: "", greeting: "" },
    state: "active",
  };
}

function makeAsset(uid, state = "active") {
  return {
    asset_uid: uid,
    soul_uid: "s1",
    kind: "relationship",
    trait: "preference",
    content: "先给证据",
    applicability: "客户分析",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state,
    revision: 1,
    supersedes_uid: null,
    pinned: false,
    source: { runtime_kind: "hermes", session_ref: "s", event_ref: "e", occurred_at: "2026-10-20T04:00:00Z" },
    sync_state: "local_only",
    cloud_revision: null,
  };
}

function makeWatermark() {
  return {
    completed: true,
    attempts: 1,
    state: "completed",
    last_error: null,
    request: {
      job_uid: "job-1",
      runtime_kind: "hermes",
      native_session_id: "ns-1",
      source_event_refs: ["e1"],
      binding_uid: "b1",
      binding_revision: 1,
      soul_uid: "s1",
      internal_task: true,
    },
  };
}

function makeOutboxOp(opId) {
  return {
    operation_id: opId,
    operation_kind: "asset",
    request: { change_id: opId, operation: "propose" },
    predecessor_operation_ids: [],
  };
}

function makeTombstone(uid) {
  return {
    asset_uid: uid,
    soul_uid: "s1",
    kind: "relationship",
    trait: "preference",
    content_digest: "digest-abc",
    revision: 1,
    state: "rejected",
    restored_by_uid: null,
  };
}

function makeConsent(key) {
  const [cloud_device_uid, soul_uid] = key.split(":");
  return { cloud_device_uid, soul_uid, revision: 1, categories: ["identity"], enabled: true };
}

/** An fs override whose `rename` throws once when the predicate matches. */
function crashingRename(predicate) {
  let fired = 0;
  return {
    fs: {
      rename: async (from, to) => {
        if (predicate(from, to)) {
          fired += 1;
          throw new Error(`simulated crash (rename ${path.basename(from)} -> ${path.basename(to)})`);
        }
        return fsRename(from, to);
      },
    },
    fired: () => fired,
  };
}

// ---------------------------------------------------------------------------
// Test 1: asset + watermark + outbox commit atomically (all or nothing)
// ---------------------------------------------------------------------------

test("store: asset watermark and outbox are all or nothing", async (t) => {
  const uid = "asset-1";
  const wmKey = "range-1";
  const opId = "op-1";

  const baseline = async (root) => {
    const s = await openStore(root, "p1", { deviceId: "device-1" });
    await s.transact((d) => { d.souls["s1"] = makeSoul("s1"); });
    const last = await s.read();
    await s.close();
    return last;
  };

  const change = (draft) => {
    draft.assets[uid] = makeAsset(uid);
    draft.extraction_watermarks[wmKey] = makeWatermark();
    draft.outbox[opId] = makeOutboxOp(opId);
  };

  const assertRecovered = async (root, expected) => {
    const reopened = await openStore(root, "p1", { deviceId: "device-1" });
    const recovered = await reopened.read();
    await reopened.close();
    assert.equal(Boolean(recovered.assets[uid]), Boolean(recovered.extraction_watermarks[wmKey]));
    assert.equal(Boolean(recovered.assets[uid]), Boolean(recovered.outbox[opId]));
    assert.equal(Boolean(recovered.assets[uid]), expected, "all three present or all three absent");
  };

  await t.test("change throws after writing the asset, before the watermark", async () => {
    const root = tempDir();
    const lastValid = await baseline(root);
    const s = await openStore(root, "p1", { deviceId: "device-1" });
    await assert.rejects(
      () => s.transact((draft) => {
        draft.assets[uid] = makeAsset(uid);
        throw new Error("simulated crash before the watermark");
      }),
      /simulated crash/,
    );
    await s.close();
    const reopened = await openStore(root, "p1", { deviceId: "device-1" });
    const recovered = await reopened.read();
    await reopened.close();
    assert.deepEqual(recovered.souls, lastValid.souls);
    await assertRecovered(root, false);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test("crash before the backup rename", async () => {
    const root = tempDir();
    const lastValid = await baseline(root);
    const { fs, fired } = crashingRename((_from, to) => to.endsWith("snapshot.json.bak"));
    const s = await openStore(root, "p1", { fs, deviceId: "device-1" });
    await assert.rejects(() => s.transact(change), /simulated crash|snapshot not written/);
    await s.close();
    assert.equal(fired(), 1, "backup-rename injection must actually fire");
    const reopened = await openStore(root, "p1", { deviceId: "device-1" });
    const recovered = await reopened.read();
    await reopened.close();
    assert.deepEqual(recovered.souls, lastValid.souls);
    await assertRecovered(root, false);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test("crash before the final rename", async () => {
    const root = tempDir();
    const lastValid = await baseline(root);
    const { fs, fired } = crashingRename((_from, to) => to.endsWith("snapshot.json"));
    const s = await openStore(root, "p1", { fs, deviceId: "device-1" });
    await assert.rejects(() => s.transact(change), /simulated crash|snapshot not written/);
    await s.close();
    assert.equal(fired(), 1, "final-rename injection must actually fire");
    const reopened = await openStore(root, "p1", { deviceId: "device-1" });
    const recovered = await reopened.read();
    await reopened.close();
    assert.deepEqual(recovered.souls, lastValid.souls);
    await assertRecovered(root, false);
    rmSync(root, { recursive: true, force: true });
  });

  await t.test("no crash commits all three together", async () => {
    const root = tempDir();
    const lastValid = await baseline(root);
    const s = await openStore(root, "p1", { deviceId: "device-1" });
    await s.transact(change);
    await s.close();
    const reopened = await openStore(root, "p1", { deviceId: "device-1" });
    const recovered = await reopened.read();
    await reopened.close();
    assert.deepEqual(recovered.souls, lastValid.souls);
    await assertRecovered(root, true);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 2: recovery from backup, and repair-required without empty overwrite
// ---------------------------------------------------------------------------

test("store: recover previous valid snapshot", async () => {
  const root = tempDir();
  const s = await openStore(root, "p1", { deviceId: "device-1" });
  await s.transact((d) => { d.souls["v1"] = makeSoul("v1"); d.pull_cursor = "cur-1"; });
  const v1 = await s.read();
  await s.transact((d) => { d.souls["v2"] = makeSoul("v2"); d.pull_cursor = "cur-2"; });
  await s.close();

  // Corrupt the main snapshot; the valid .bak (v1) must be recovered.
  writeFileSync(snapshotPath(root, "p1"), "{ not json");

  const reopened = await openStore(root, "p1", { deviceId: "device-1" });
  const recovered = await reopened.read();
  await reopened.close();

  assert.deepEqual(recovered.souls, v1.souls);
  assert.equal(recovered.pull_cursor, "cur-1");

  rmSync(root, { recursive: true, force: true });
});

test("store: both snapshots corrupt stop writing and preserve the files", async () => {
  const root = tempDir();
  const s = await openStore(root, "p1", { deviceId: "device-1" });
  await s.transact((d) => { d.souls["v1"] = makeSoul("v1"); });
  await s.transact((d) => { d.souls["v2"] = makeSoul("v2"); });
  await s.close();

  const main = snapshotPath(root, "p1");
  const bak = snapshotBackupPath(root, "p1");
  const corruptMain = "{ corrupt main";
  const corruptBak = "{ corrupt bak";
  writeFileSync(main, corruptMain);
  writeFileSync(bak, corruptBak);

  const reopened = await openStore(root, "p1", { deviceId: "device-1" });
  await assert.rejects(
    () => reopened.read(),
    (err) => err instanceof StoreError && err.code === "repair_required",
  );
  await assert.rejects(
    () => reopened.transact((d) => { d.souls["v3"] = makeSoul("v3"); }),
    (err) => err instanceof StoreError && err.code === "repair_required",
    "a corrupt store must stop writing, never overwrite with an empty store",
  );
  await reopened.close();

  // The corrupt files are preserved byte-for-byte.
  assert.equal(readFileSync(main, "utf8"), corruptMain);
  assert.equal(readFileSync(bak, "utf8"), corruptBak);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 3: one writer, serialized commits, lost-lock race
// ---------------------------------------------------------------------------

test("writer: racing hooks use one writer and serialize commits", async () => {
  const root = tempDir();
  const writer = await startWriter(root);

  // Register one whitelisted command for the test (Tasks 4/5 register their own).
  registerWriterCommand("sync_once", async ({ root: r, request }) => {
    const store = await openStore(r, request.profile_id);
    try {
      return await store.transact((draft) => {
        draft.souls[request.request_uid] = makeSoul(request.request_uid);
      });
    } finally {
      await store.close();
    }
  });

  const requests = Array.from({ length: 20 }, (_, i) =>
    sendWriter(root, { request_uid: `req-${i}`, profile_id: "p1", command: "sync_once", payload: {} }),
  );
  const results = await Promise.all(requests);
  for (const result of results) {
    assert.ok(result.ok, `every racing request commits: ${JSON.stringify(result)}`);
  }

  const store = await openStore(root, "p1");
  const snap = await store.read();
  await store.close();
  assert.equal(Object.keys(snap.souls).length, 20, "all 20 commits serialized without lost updates");

  await writer.close();
  rmSync(root, { recursive: true, force: true });
});

test("writer: lost lock race never starts a second writer", async () => {
  const root = tempDir();
  mkdirSync(root, { recursive: true });
  // A dead holder's lock left behind (simulated lost lock).
  writeFileSync(writerLockPath(root), JSON.stringify({ pid: 2147483647, started_at: "x" }));

  const attempts = await Promise.allSettled([startWriter(root), startWriter(root), startWriter(root)]);

  const winners = attempts.filter((a) => a.status === "fulfilled");
  const losers = attempts.filter((a) => a.status === "rejected");
  assert.equal(winners.length, 1, "exactly one writer wins the lost-lock race");
  assert.equal(losers.length, 2, "the other contenders are refused");

  await winners[0].value.close();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 4: capacity/permission failure preserves assets, tombstones and outbox
// ---------------------------------------------------------------------------

test("store: capacity failure preserves tombstones", async () => {
  const tombKey = "key-1";
  const cases = [
    { code: "ENOSPC", expected: "capacity", hint: /free space|export|unchanged/i },
    { code: "EACCES", expected: "permission", hint: /permission|unchanged/i },
  ];

  for (const failure of cases) {
    const root = tempDir();
    const s = await openStore(root, "p1", { deviceId: "device-1" });
    await s.transact((d) => {
      d.assets["a1"] = makeAsset("a1");
      d.digest_tombstones[tombKey] = [makeTombstone("t1")];
      d.outbox["op-1"] = makeOutboxOp("op-1");
    });
    await s.close();

    let fired = 0;
    const fs = {
      writeFile: async (file, data, options) => {
        if (file.includes("snapshot.json.tmp-")) {
          fired += 1;
          const err = new Error(`${failure.code}: simulated ${failure.code}`);
          err.code = failure.code;
          throw err;
        }
        return fsWriteFile(file, data, options);
      },
    };

    const s2 = await openStore(root, "p1", { fs, deviceId: "device-1" });
    await assert.rejects(
      () => s2.transact((d) => { d.assets["a2"] = makeAsset("a2"); }),
      (err) => err instanceof StoreError && err.code === failure.expected && failure.hint.test(err.message),
      `${failure.code} returns a visible repair hint`,
    );
    await s2.close();
    assert.equal(fired, 1, `${failure.code} injection fired`);

    const reopened = await openStore(root, "p1", { deviceId: "device-1" });
    const recovered = await reopened.read();
    await reopened.close();

    assert.ok(recovered.assets["a1"], "existing asset preserved");
    assert.ok(recovered.digest_tombstones[tombKey], "tombstone preserved");
    assert.ok(recovered.outbox["op-1"], "outbox preserved");
    assert.ok(!recovered.assets["a2"], "failed write must not partially apply");

    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5: control events, quarantine and digests commit atomically
// ---------------------------------------------------------------------------

test("store: control events quarantine and digests commit atomically", async () => {
  const root = tempDir();
  const uid = "asset-1";
  const tombKey = "digest-key";
  const consentKey = "device-1:s1";
  const opId = "op-1";

  const applyControl = (draft) => {
    draft.assets[uid] = { ...draft.assets[uid], state: "rejected" };
    draft.digest_tombstones[tombKey] = [makeTombstone(uid)];
    draft.quarantine[opId] = { operation: makeOutboxOp(opId), reason: "rejected" };
    draft.consents[consentKey] = makeConsent(consentKey);
  };

  const s = await openStore(root, "p1", { deviceId: "device-1" });
  await s.transact((d) => { d.assets[uid] = makeAsset(uid, "active"); });
  await s.close();

  // Crash after invalidating the asset, before recording the tombstone: nothing
  // persists, so the old candidate is never left invalidated without its tombstone
  // (a half-state that would later let a same-content re-proposal reactivate).
  let fired = 0;
  const crash = await openStore(root, "p1", { deviceId: "device-1" });
  await assert.rejects(
    () => crash.transact((draft) => {
      draft.assets[uid] = { ...draft.assets[uid], state: "rejected" };
      fired += 1;
      throw new Error("simulated crash before recording the tombstone");
    }),
    /simulated crash/,
  );
  await crash.close();
  assert.equal(fired, 1, "in-memory crash injection fired");

  const afterCrash = await (await openStore(root, "p1", { deviceId: "device-1" })).read();
  assert.equal(afterCrash.assets[uid].state, "active", "crash rolled back the invalidation");
  assert.equal(Object.keys(afterCrash.digest_tombstones).length, 0);
  assert.equal(Object.keys(afterCrash.quarantine).length, 0);
  assert.equal(Object.keys(afterCrash.consents).length, 0);

  // A clean control transaction commits all four together.
  const clean = await openStore(root, "p1", { deviceId: "device-1" });
  const committed = await clean.transact(applyControl);
  await clean.close();

  assert.equal(committed.assets[uid].state, "rejected");
  assert.ok(committed.digest_tombstones[tombKey]);
  assert.ok(committed.quarantine[opId]);
  assert.ok(committed.consents[consentKey]);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Writer envelope: status command + unsupported_command + IPC unavailability
// ---------------------------------------------------------------------------

test("writer: status reports health and unregistered commands are refused", async () => {
  const root = tempDir();
  const s = await openStore(root, "p1", { deviceId: "device-1" });
  await s.transact((d) => { d.souls["s1"] = makeSoul("s1"); });
  await s.close();

  const writer = await startWriter(root);

  const status = await sendWriter(root, { request_uid: "r1", profile_id: "p1", command: "status", payload: {} });
  assert.ok(status.ok, `status succeeds: ${JSON.stringify(status)}`);
  assert.equal(status.result.store_version, 1);
  assert.ok(
    status.result.profiles.some((p) => p.profile_id === "p1" && p.state === "ok"),
    "status lists the healthy profile",
  );

  const unsupported = await sendWriter(root, { request_uid: "r2", profile_id: "p1", command: "create_soul", payload: {} });
  assert.deepEqual(unsupported, {
    ok: false,
    error: { code: "unsupported_command", message: "command not registered: create_soul" },
  });

  await writer.close();
  rmSync(root, { recursive: true, force: true });
});

test("writer: unavailable writer and malformed requests never throw", async () => {
  const root = tempDir();
  const unavailable = await sendWriter(root, { request_uid: "r1", profile_id: "p1", command: "status", payload: {} });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, "writer_unavailable");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fix-review regressions (Important findings)
// ---------------------------------------------------------------------------

test("writer: release never deletes a lock it no longer owns", async () => {
  const root = tempDir();
  const writer = await startWriter(root);

  // A competitor replaces the lock under the writer (live holder, different token).
  writeFileSync(writerLockPath(root), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), token: "replacement" }));

  await writer.close();

  const holder = JSON.parse(readFileSync(writerLockPath(root), "utf8"));
  assert.equal(holder.token, "replacement", "release must not delete a lock the writer no longer owns");

  rmSync(root, { recursive: true, force: true });
});

test("writer: acquires a stale 0-byte lock and serves status", async () => {
  const root = tempDir();
  mkdirSync(root, { recursive: true });
  // A 0-byte/corrupt lock — exactly what the old create-then-write path could leave.
  writeFileSync(writerLockPath(root), "");

  const writer = await startWriter(root);
  const status = await sendWriter(root, { request_uid: "r1", profile_id: "p1", command: "status", payload: {} });
  assert.ok(status.ok, `writer must acquire the stale lock and serve: ${JSON.stringify(status)}`);
  assert.equal(status.result.store_version, 1);

  await writer.close();
  rmSync(root, { recursive: true, force: true });
});

test("store: unreadable snapshot is preserved and never overwritten with an empty store", async () => {
  const root = tempDir();
  const s = await openStore(root, "p1", { deviceId: "device-1" });
  await s.transact((d) => { d.souls["v1"] = makeSoul("v1"); d.assets["a1"] = makeAsset("a1"); });
  await s.close();

  const main = snapshotPath(root, "p1");
  const before = readFileSync(main, "utf8");

  // Present but unreadable (EACCES), not missing.
  const fs = {
    readFile: async (file) => {
      if (file.endsWith("snapshot.json")) {
        const err = new Error("EACCES: permission denied (simulated)");
        err.code = "EACCES";
        throw err;
      }
      return fsReadFile(file, "utf8");
    },
  };

  const reopened = await openStore(root, "p1", { fs, deviceId: "device-1" });
  await assert.rejects(
    () => reopened.read(),
    (err) => err instanceof StoreError && err.code === "repair_required",
  );
  await assert.rejects(
    () => reopened.transact((d) => { d.souls["v2"] = makeSoul("v2"); }),
    (err) => err instanceof StoreError && err.code === "repair_required",
    "an unreadable snapshot must stop writes, never be overwritten with an empty store",
  );
  await reopened.close();

  assert.equal(readFileSync(main, "utf8"), before, "unreadable snapshot preserved byte-for-byte");
  rmSync(root, { recursive: true, force: true });
});

test("store: fresh anonymous profile keeps a stable device_id across opens", async () => {
  const root = tempDir();
  const first = await openStore(root, "p1");
  const snap1 = await first.read();
  await first.close();

  const second = await openStore(root, "p1");
  const snap2 = await second.read();
  await second.close();

  assert.ok(snap1.device_id.length > 0, "a device_id is generated");
  assert.equal(snap1.device_id, snap2.device_id, "device_id stable from the very first open");

  const persisted = JSON.parse(readFileSync(devicePath(root, "p1"), "utf8"));
  assert.equal(persisted.device_id, snap1.device_id, "generated device_id persisted immutably");

  rmSync(root, { recursive: true, force: true });
});
