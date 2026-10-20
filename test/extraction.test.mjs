#!/usr/bin/env node
/**
 * Task 4: bounded extraction scheduling, classification and internal-task isolation.
 *
 * The seven named tests from the brief are written first and must fail for the
 * right reason (the modules do not exist yet), then turn green once the
 * implementation lands. Everything runs against temp homes via explicit `root`
 * arguments — no real HOME, no network, no installed agents, no live model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openStore, acquireWriterLock } from "../dist/local/store.js";
import { resolveBinding } from "../dist/local/bindings.js";
import { startWriter, sendWriter } from "../dist/local/writer.js";
import { createDaemon } from "../dist/agentd/daemon.js";
import { randomUUID } from "node:crypto";
import {
  scheduleExtraction,
  handleRuntimeEvent,
  drainPendingExtractions,
  rangeForEvent,
  watermarkKey,
  isInternalEvent,
  MAX_AUTO_ATTEMPTS,
} from "../dist/extraction/scheduler.js";
import { classifyProposalState } from "../dist/assets/validation.js";
import { contentDigest } from "../dist/assets/protocol.js";
import { loadContractFixture, classificationCases } from "./helpers/contract-fixture.mjs";
import { createFakeAdapter } from "./helpers/fake-runtime.mjs";

const { fixture } = loadContractFixture();

function tempDir(prefix = "extraction-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSoul(uid) {
  return {
    soul_uid: uid,
    legacy_host_id: null,
    identity_revision: 1,
    identity: { name: "Growth", description: "", character: "", greeting: "" },
    state: "active",
  };
}

function makeConsent(cloudDeviceUid, soulUid, categories = ["identity", "relationship", "experience"]) {
  return { cloud_device_uid: cloudDeviceUid, soul_uid: soulUid, revision: 1, categories, enabled: true };
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

function caseProposal(name) {
  const c = classificationCases(fixture).find((x) => x.name === name);
  return c && c.proposedPayload ? structuredClone(c.proposedPayload) : null;
}

const RANGE = { event_refs: ["turn-opaque-001"], start: 0, end: 4 };

async function readSnap(root, profileId) {
  const store = await openStore(root, profileId);
  const snap = await store.read();
  await store.close();
  return snap;
}

function assetOutboxOps(snap) {
  return Object.values(snap.outbox).filter((op) => op.operation_kind === "asset");
}

// ---------------------------------------------------------------------------
// 1. internal hooks never schedule another job
// ---------------------------------------------------------------------------

test("extraction: internal hooks never schedule another job", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  // isInternalEvent is the only recursion guard.
  assert.equal(isInternalEvent({ key, event_ref: "e", kind: "checkpoint", internal_job_uid: "job-x" }), true);
  assert.equal(isInternalEvent({ key, event_ref: "e", kind: "checkpoint", internal_job_uid: null }), false);
  assert.equal(isInternalEvent({ key, event_ref: "e", kind: "checkpoint", internal_job_uid: "" }), false);

  const internalResults = [];
  let modelCallsForRange = 0;
  const adapter = createFakeAdapter("hermes", {
    extract: async (request) => {
      modelCallsForRange += 1;
      // The model task fires its own hooks mid-run (its messages / subtasks / Stop);
      // every one carries the internal job uid so the scheduler can exclude them.
      internalResults.push(
        await handleRuntimeEvent(
          { key, event_ref: "internal-stop", kind: "turn_completed", internal_job_uid: request.job_uid },
          { root, adapter },
        ),
      );
      internalResults.push(
        await handleRuntimeEvent(
          { key, event_ref: "internal-subtask", kind: "checkpoint", internal_job_uid: request.job_uid },
          { root, adapter },
        ),
      );
      return { error: { code: "quota", retryable: true } };
    },
  });

  // Three applicable checkpoints for the SAME source range drive at most two model
  // calls: the range's 2-attempt budget is shared, so the third is refused.
  const checkpoint = { key, kind: "checkpoint", internal_job_uid: null };
  await handleRuntimeEvent({ ...checkpoint, event_ref: "cp-1" }, { root, adapter });
  await handleRuntimeEvent({ ...checkpoint, event_ref: "cp-1" }, { root, adapter });
  await handleRuntimeEvent({ ...checkpoint, event_ref: "cp-1" }, { root, adapter });

  assert.equal(modelCallsForRange, 2, "the real source range is extracted at most twice");
  assert.ok(internalResults.length > 0, "the internal markers actually flowed");
  for (const result of internalResults) {
    assert.equal(result.scheduled, false, "an internal event is never scheduled");
  }

  const snap = await readSnap(root, "p1");
  const rangeKey = watermarkKey(binding, rangeForEvent({ key, event_ref: "cp-1", kind: "checkpoint", internal_job_uid: null }));
  assert.equal(snap.extraction_watermarks[rangeKey].completed, false, "failed attempts never complete the range");
  assert.equal(snap.extraction_watermarks[rangeKey].attempts, 2, "the budget counter stops at the automatic maximum");
  assert.equal(Object.keys(snap.assets).length, 0, "a failed extraction never creates assets");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. interrupt does not advance success watermark
// ---------------------------------------------------------------------------

test("extraction: interrupt does not advance success watermark", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  let modelCalls = 0;
  const adapter = createFakeAdapter("hermes", {
    extract: async () => {
      modelCalls += 1;
      return { error: { code: "interrupt", retryable: true } };
    },
  });

  // A single schedule = one model call: no immediate forced re-run after a failure.
  await scheduleExtraction(binding, RANGE, { root, adapter });
  assert.equal(modelCalls, 1, "an interrupted job is not immediately retried in a loop");

  const snap = await readSnap(root, "p1");
  const rangeKey = watermarkKey(binding, RANGE);
  const watermark = snap.extraction_watermarks[rangeKey];
  assert.equal(watermark.completed, false, "the success watermark is not advanced by an interrupt");
  assert.ok(["pending", "error"].includes(watermark.state), "pending/error is preserved, not completed");
  assert.equal(watermark.attempts, 1, "one attempt was consumed");
  assert.ok(watermark.last_error, "the interrupt reason is recorded locally");
  assert.equal(Object.keys(snap.assets).length, 0, "an interrupt never creates assets");
  assert.equal(assetOutboxOps(snap).length, 0, "an interrupt never enqueues a network operation");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. stale binding cannot commit
// ---------------------------------------------------------------------------

test("extraction: stale binding cannot commit", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });
  assert.equal(binding.revision, 1);

  // A real writer serializes every store write, so the commit of the late model
  // result is re-checked against the detached binding exactly once, with no
  // cross-process lost update.
  const writer = await startWriter(root);

  // The model "returns" late: extract waits until the test releases the gate.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = createFakeAdapter("hermes", {
    extract: async () => {
      await gate;
      return { proposals: [caseProposal("explicit_durable_preference")] };
    },
  });

  const run = scheduleExtraction(binding, RANGE, { root, adapter });
  // While the model is in flight the user detaches the session (revision 2), via
  // the writer so it serializes with the pending/commit writes.
  const detached = await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: "p1",
    command: "detach",
    payload: { device_id: "dev-1", runtime_kind: "hermes", native_session_id: "ns-1" },
  });
  assert.equal(detached.ok, true, "the detach is applied by the writer");
  release();
  await run;
  await writer.close();

  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.assets).length, 0, "a stale result never commits an asset");
  assert.equal(assetOutboxOps(snap).length, 0, "a stale result never enqueues a propose for a new binding");
  const rangeKey = watermarkKey(binding, RANGE);
  assert.equal(
    snap.extraction_watermarks[rangeKey]?.completed,
    false,
    "a stale result never advances the success watermark",
  );
  assert.equal(
    snap.extraction_watermarks[rangeKey]?.last_error,
    "stale_binding",
    "the re-check before commit records the typed refusal",
  );

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. temporary request creates no asset (shared fixture: one_turn_instruction)
// ---------------------------------------------------------------------------

test("extraction: temporary request creates no asset", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  const adapter = createFakeAdapter("hermes", { extract: async () => ({ proposals: [] }) });
  await scheduleExtraction(binding, RANGE, { root, adapter });

  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.assets).length, 0, "a one-turn instruction produces no long-term asset");
  assert.equal(assetOutboxOps(snap).length, 0, "nothing to propose");
  assert.equal(snap.extraction_watermarks[watermarkKey(binding, RANGE)].completed, true, "the range is still completed");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. inference and unverified method remain candidates (shared fixture)
// ---------------------------------------------------------------------------

test("extraction: inference and unverified method remain candidates", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  const proposals = [
    caseProposal("inferred_preference"),
    caseProposal("unverified_method"),
  ];
  assert.ok(proposals.every(Boolean), "fixture proposals are present");

  const adapter = createFakeAdapter("hermes", { extract: async () => ({ proposals }) });
  await scheduleExtraction(binding, RANGE, { root, adapter });

  const snap = await readSnap(root, "p1");
  const assets = Object.values(snap.assets);
  assert.equal(assets.length, 2, "both unverified/inferred proposals are kept");
  for (const asset of assets) {
    assert.equal(asset.state, "candidate", `${asset.kind}/${asset.trait} is downgraded to candidate`);
    assert.equal(asset.sync_state, "pending_sync", "an authorized candidate is still queued for the owner to review");
  }
  assert.equal(snap.extraction_watermarks[watermarkKey(binding, RANGE)].completed, true);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. explicit long term preference activates (shared fixture)
// ---------------------------------------------------------------------------

test("extraction: explicit long term preference activates", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  const adapter = createFakeAdapter("hermes", {
    extract: async () => ({ proposals: [caseProposal("explicit_durable_preference")] }),
  });
  await scheduleExtraction(binding, RANGE, { root, adapter });

  const snap = await readSnap(root, "p1");
  const assets = Object.values(snap.assets);
  assert.equal(assets.length, 1, "the explicit durable preference becomes one asset");
  assert.equal(assets[0].state, "active", "a normal explicit preference is active without conflict");
  assert.equal(assets[0].verification, "unverified", "an explicit statement is not a verified outcome");
  assert.equal(assets[0].sync_state, "pending_sync");

  const ops = assetOutboxOps(snap);
  assert.equal(ops.length, 1, "successful extraction enqueues exactly one propose");
  assert.equal(ops[0].request.actor, "model");
  assert.equal(ops[0].request.binding_revision, binding.revision);

  const watermark = snap.extraction_watermarks[watermarkKey(binding, RANGE)];
  assert.equal(watermark.completed, true);
  assert.equal(watermark.attempts, 1);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. empty proposals complete range
// ---------------------------------------------------------------------------

test("extraction: empty proposals complete range", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  const adapter = createFakeAdapter("hermes", { extract: async () => ({ proposals: [] }) });
  await scheduleExtraction(binding, RANGE, { root, adapter });

  const snap = await readSnap(root, "p1");
  const watermark = snap.extraction_watermarks[watermarkKey(binding, RANGE)];
  assert.equal(watermark.completed, true, "nothing worth remembering still completes the range");
  assert.equal(Object.keys(snap.assets).length, 0, "no empty asset is manufactured");
  assert.equal(assetOutboxOps(snap).length, 0);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// classification rule aligns with the shared fixture (and the 2-attempt cap)
// ---------------------------------------------------------------------------

test("extraction: classification cases align with the shared fixture", async () => {
  assert.equal(MAX_AUTO_ATTEMPTS, 2, "the automatic budget is exactly two attempts");
  for (const c of classificationCases(fixture)) {
    if (c.proposedPayload === null) {
      // The temporary/one-turn case promises zero proposals. Driving that promise
      // through the scheduler must yield no asset and no cloud-bound propose op —
      // asserted against the implementation, not the fixture's own `proposal_count`.
      const root = tempDir();
      await seedProfile(root, "p1", "dev-1", (d) => {
        d.souls["s1"] = makeSoul("s1");
        d.consents["cdu:s1"] = makeConsent("cdu", "s1");
      });
      const binding = await resolveBinding(keyOf("p1", "dev-1", "hermes", "ns-1"), undefined, { root });
      await scheduleExtraction(binding, RANGE, {
        root,
        adapter: createFakeAdapter("hermes", { extract: async () => ({ proposals: [] }) }),
      });
      const snap = await readSnap(root, "p1");
      assert.equal(Object.keys(snap.assets).length, 0, `${c.name} yields no asset`);
      assert.equal(assetOutboxOps(snap).length, 0, `${c.name} yields no cloud-bound propose op`);
      rmSync(root, { recursive: true, force: true });
      continue;
    }
    const state = classifyProposalState(c.proposedPayload, {});
    assert.equal(state, c.expected.asset_state, `${c.name} classifies as ${c.expected.asset_state}`);
    if (c.expected.verification) {
      assert.equal(c.proposedPayload.verification, c.expected.verification, `${c.name} keeps its verification`);
    }
  }
});

test("extraction: sensitive or tombstoned content never auto-activates", () => {
  const base = caseProposal("explicit_durable_preference");
  const sensitive = { ...base, sensitivity: "sensitive" };
  assert.equal(classifyProposalState(sensitive, {}), "candidate", "sensitive content is downgraded");

  const conflicted = { ...base, content: "分析客户时，先给真实付费证据，再讨论渠道。" };
  assert.equal(
    classifyProposalState(conflicted, { blockedByTombstone: true }),
    "candidate",
    "a digest-tombstone conflict is downgraded to candidate",
  );
});

// ---------------------------------------------------------------------------
// single-writer fallback takes the lock; concurrent commits are never lost
// ---------------------------------------------------------------------------

test("extraction: the fallback takes the writer lock instead of writing locklessly", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const binding = await resolveBinding(keyOf("p1", "dev-1", "hermes", "ns-1"), undefined, { root });

  // Hold the writer lock WITHOUT listening: this is exactly the window where a
  // socket connect fails (`writer_unavailable`) while the lock is still taken.
  const releaseLock = await acquireWriterLock(root);
  let modelCalls = 0;
  try {
    await scheduleExtraction(binding, RANGE, {
      root,
      adapter: createFakeAdapter("hermes", {
        extract: async () => {
          modelCalls += 1;
          return { proposals: [] };
        },
      }),
    });
    const snap = await readSnap(root, "p1");
    assert.equal(Object.keys(snap.extraction_watermarks).length, 0, "no lockless watermark write");
    assert.equal(Object.keys(snap.assets).length, 0, "no lockless asset write");
    assert.equal(modelCalls, 0, "no model call when the attempt cannot be reserved under the lock");
  } finally {
    await releaseLock();
  }
  rmSync(root, { recursive: true, force: true });
});

test("extraction: concurrent commits through the writer are never lost", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const binding = await resolveBinding(keyOf("p1", "dev-1", "hermes", "ns-1"), undefined, { root });
  const writer = await startWriter(root);
  const proposal = caseProposal("explicit_durable_preference");
  const adapter = createFakeAdapter("hermes", { extract: async () => ({ proposals: [proposal] }) });

  await Promise.all([
    scheduleExtraction(binding, { event_refs: ["turn-a"], start: 1, end: 1 }, { root, adapter }),
    scheduleExtraction(binding, { event_refs: ["turn-b"], start: 2, end: 2 }, { root, adapter }),
  ]);
  await writer.close();

  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.assets).length, 2, "both concurrent commits land");
  assert.equal(assetOutboxOps(snap).length, 2, "both propose ops are enqueued");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// drain budget
// ---------------------------------------------------------------------------

test("extraction: drain exhausts the 2-attempt budget and refuses a third run", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const binding = await resolveBinding(keyOf("p1", "dev-1", "hermes", "ns-1"), undefined, { root });
  const rangeKey = watermarkKey(binding, RANGE);

  // Seed a pending, zero-attempt watermark so the drain itself must reserve each
  // attempt through the same writer command the schedule path uses.
  const store = await openStore(root, "p1");
  await store.transact((d) => {
    d.extraction_watermarks[rangeKey] = {
      completed: false,
      attempts: 0,
      state: "pending",
      last_error: null,
      request: {
        job_uid: "seed-job",
        runtime_kind: "hermes",
        native_session_id: binding.native_session_id,
        source_event_refs: RANGE.event_refs.slice(),
        binding_uid: binding.binding_uid,
        binding_revision: binding.revision,
        soul_uid: binding.soul_uid,
        internal_task: true,
      },
    };
  });
  await store.close();

  let modelCalls = 0;
  const adapter = createFakeAdapter("hermes", {
    extract: async () => {
      modelCalls += 1;
      return { error: { code: "quota", retryable: true } };
    },
  });

  await drainPendingExtractions(root, { hermes: adapter });
  await drainPendingExtractions(root, { hermes: adapter });
  await drainPendingExtractions(root, { hermes: adapter });

  assert.equal(modelCalls, 2, "a persistently failing range is extracted exactly twice across three drains");

  const snap = await readSnap(root, "p1");
  const wm = snap.extraction_watermarks[rangeKey];
  assert.equal(wm.completed, false, "the range stays incomplete");
  assert.equal(wm.attempts, 2, "the drain incremented attempts to the automatic maximum");
  assert.equal(wm.state, "error", "the failure is recorded locally");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// daemon wiring
// ---------------------------------------------------------------------------

test("extraction: a daemon tick drains a runtime-event watermark end-to-end", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  const writer = await startWriter(root);

  // The hook's assets-mode emission: a checkpoint writes a pending watermark.
  const event = { key, event_ref: "turn-opaque-001", kind: "checkpoint", internal_job_uid: null };
  const emitted = await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: "p1",
    command: "runtime_event",
    payload: { event },
  });
  assert.equal(emitted.ok, true, "the runtime event is accepted and a pending watermark is written");

  const proposal = caseProposal("explicit_durable_preference");
  const adapter = createFakeAdapter("hermes", { extract: async () => ({ proposals: [proposal] }) });

  const daemon = createDaemon(
    { root, apiBaseUrl: "http://127.0.0.1:0", machineId: "m-1", tokens: {}, home: root },
    { extractAdapters: { hermes: adapter } },
  );

  // The same bounded drain the daemon tick fires, awaited directly for determinism.
  const drained = await daemon.drainExtractions();
  assert.equal(drained.completed, 1, "the pending watermark is drained and committed");

  await writer.close();

  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.assets).length, 1, "the drained job commits an asset");
  assert.equal(assetOutboxOps(snap).length, 1, "the authorized asset is queued for cloud propose");
  const rangeKey = watermarkKey(binding, rangeForEvent(event));
  assert.equal(snap.extraction_watermarks[rangeKey].completed, true, "the range completes via the daemon");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// disjoint ranges have independent budgets (fix: range derived from event refs)
// ---------------------------------------------------------------------------

test("extraction: disjoint ranges in one session have independent budgets", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  await resolveBinding(key, undefined, { root });

  const calls = { ra: 0, rb: 0 };
  const adapter = createFakeAdapter("hermes", {
    extract: async (request) => {
      if (request.source_event_refs[0] === "ra") calls.ra += 1;
      else calls.rb += 1;
      return { error: { code: "quota", retryable: true } };
    },
  });

  await handleRuntimeEvent({ key, event_ref: "ra", kind: "checkpoint", internal_job_uid: null }, { root, adapter });
  await handleRuntimeEvent({ key, event_ref: "rb", kind: "checkpoint", internal_job_uid: null }, { root, adapter });

  const snap = await readSnap(root, "p1");
  const watermarks = Object.values(snap.extraction_watermarks);
  assert.equal(watermarks.length, 2, "two disjoint ranges keep two independent watermarks");
  for (const wm of watermarks) {
    assert.equal(wm.attempts, 1, "each range consumes its own first attempt");
  }
  assert.equal(calls.ra, 1, "range ra is extracted once");
  assert.equal(calls.rb, 1, "range rb is extracted once");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// digest tombstone suppresses auto-activation through the real digest path
// ---------------------------------------------------------------------------

test("extraction: a digest tombstone suppresses auto-activation end-to-end", async () => {
  const root = tempDir();
  const proposal = caseProposal("explicit_durable_preference");
  const digest = contentDigest(proposal.content);
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
    d.digest_tombstones["tombstone-key"] = [
      {
        asset_uid: "tomb-1",
        soul_uid: "s1",
        kind: "relationship",
        trait: "preference",
        content_digest: digest,
        revision: 1,
        state: "rejected",
        restored_by_uid: null,
      },
    ];
  });
  const binding = await resolveBinding(keyOf("p1", "dev-1", "hermes", "ns-1"), undefined, { root });

  const adapter = createFakeAdapter("hermes", { extract: async () => ({ proposals: [proposal] }) });
  await scheduleExtraction(binding, RANGE, { root, adapter });

  const snap = await readSnap(root, "p1");
  const assets = Object.values(snap.assets);
  assert.equal(assets.length, 1, "the tombstoned proposal still becomes an asset for review, not dropped");
  assert.equal(assets[0].state, "candidate", "the digest tombstone downgrades via tombstoneHit, not a pre-set boolean");
  assert.equal(assets[0].sync_state, "pending_sync", "an authorized candidate is still queued for review");

  rmSync(root, { recursive: true, force: true });
});
