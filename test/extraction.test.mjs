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

import { openStore } from "../dist/local/store.js";
import { resolveBinding } from "../dist/local/bindings.js";
import { startWriter, sendWriter } from "../dist/local/writer.js";
import { randomUUID } from "node:crypto";
import {
  scheduleExtraction,
  handleRuntimeEvent,
  watermarkKey,
  isInternalEvent,
  MAX_AUTO_ATTEMPTS,
} from "../dist/extraction/scheduler.js";
import { classifyProposalState } from "../dist/assets/validation.js";
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

  // Two applicable checkpoints drive at most two model calls for the range.
  await handleRuntimeEvent({ key, event_ref: "cp-1", kind: "checkpoint", internal_job_uid: null }, { root, adapter });
  await handleRuntimeEvent({ key, event_ref: "cp-2", kind: "checkpoint", internal_job_uid: null }, { root, adapter });
  // A third checkpoint is refused: the 2-attempt budget is exhausted, no immediate loop.
  await handleRuntimeEvent({ key, event_ref: "cp-3", kind: "checkpoint", internal_job_uid: null }, { root, adapter });

  assert.equal(modelCallsForRange, 2, "the real source range is extracted at most twice");
  assert.ok(internalResults.length > 0, "the internal markers actually flowed");
  for (const result of internalResults) {
    assert.equal(result.scheduled, false, "an internal event is never scheduled");
  }

  const snap = await readSnap(root, "p1");
  const rangeKey = watermarkKey(binding, { event_refs: ["cp-1"], start: 0, end: 0 });
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

test("extraction: classification cases align with the shared fixture", () => {
  assert.equal(MAX_AUTO_ATTEMPTS, 2, "the automatic budget is exactly two attempts");
  for (const c of classificationCases(fixture)) {
    if (c.proposedPayload === null) {
      assert.equal(c.expected.proposal_count ?? 0, 0, `${c.name} produces no proposal`);
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
