#!/usr/bin/env node
/**
 * Task 6: the first real runtime adapter — Claude Code lifecycle hooks, structured
 * extraction from a completed turn, and context injection with receipts.
 *
 * The three named tests are written first and must fail for the right reason (the
 * adapter module does not exist yet), then turn green once `createClaudeCodeAdapter`
 * lands. Everything runs against temp homes via explicit `root` arguments — no real
 * HOME, no network, no installed agent, no live model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeCodeAdapter, completedTurnSourceRefs, renderSourceTurn } from "../dist/adapters/claude-code.js";
import { openStore } from "../dist/local/store.js";
import { resolveBinding } from "../dist/local/bindings.js";
import { handleRuntimeEvent } from "../dist/extraction/scheduler.js";
import { ownerContextInput, recordReceipt } from "../dist/sync/client.js";
import { selectContext } from "../dist/assets/context.js";
import { contentDigest } from "../dist/assets/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const transcriptJsonl = readFileSync(
  path.join(here, "fixtures", "runtimes", "claude-code", "stop-turn.jsonl"),
  "utf8",
);

function tempDir(prefix = "adapters-") {
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

async function readSnap(root, profileId) {
  const store = await openStore(root, profileId);
  const snap = await store.read();
  await store.close();
  return snap;
}

// ---------------------------------------------------------------------------
// 1. stop extracts only the completed source turn
// ---------------------------------------------------------------------------

test("claude-code: stop extracts only the completed source turn", async () => {
  const root = tempDir();
  const completedTurnRefs = ["c-u1", "c-a1", "c-u2", "c-a2"];

  // The resolver picks the first completed turn and never follows the sidechain
  // branch, the turn_duration system record or the later turn.
  assert.deepEqual(completedTurnSourceRefs(transcriptJsonl), completedTurnRefs);

  const reads = [];
  let modelInput = null;
  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs) => {
      reads.push(refs.slice());
      // The marker ref maps to the raw transcript; the resolved record refs map to
      // the bounded turn text (what a real readSource returns for those records).
      if (refs.length > 0 && refs.every((r) => typeof r === "string" && r.startsWith("c-"))) {
        return renderSourceTurn(transcriptJsonl, refs);
      }
      return transcriptJsonl;
    },
    invoke: async (runtime, args, input, jobUid) => {
      assert.equal(runtime, "claude-code", "the native tool is claude-code");
      assert.equal(jobUid, "job-1", "the model call is tagged with the job uid");
      assert.ok(args.includes("--output-format"), "the native model capability is structured JSON output");
      modelInput = input;
      return { code: 0, stdout: "[]", stderr: "" };
    },
    emit: async () => {},
  });

  const result = await adapter.extract({
    job_uid: "job-1",
    runtime_kind: "claude-code",
    native_session_id: "ns-1",
    source_event_refs: ["stop-marker"],
    binding_uid: "b1",
    binding_revision: 1,
    soul_uid: "s1",
    internal_task: true,
  });
  assert.deepEqual(result, { proposals: [] });

  // The adapter resolved the opaque marker into the completed turn's concrete refs
  // and re-read exactly those through readSource — the effective extraction source.
  assert.equal(reads.length, 2, "raw source is read twice through the readSource seam");
  assert.deepEqual(reads[0], ["stop-marker"]);
  const extractionRequest = { source_event_refs: reads[1] };
  assert.deepEqual(extractionRequest.source_event_refs, completedTurnRefs);

  // The model received only the completed turn's source — no sidechain, no later turn.
  assert.ok(modelInput.includes("给 /users 接口加分页"), "the completed turn's user text is present");
  assert.ok(modelInput.includes("给查询层加上 limit/offset"), "the completed turn's assistant text is present");
  assert.ok(!modelInput.includes("内部子代理的私活"), "the sidechain record is excluded");
  assert.ok(!modelInput.includes("默认 page size 用 20"), "the later turn is excluded");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. internal extraction stop is ignored
// ---------------------------------------------------------------------------

test("claude-code: internal extraction stop is ignored", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  let internalJobUidPassed = null;
  let internalStopScheduledJobs = 0;
  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async () => transcriptJsonl,
    invoke: async (runtime, args, input, internal_job_uid) => {
      internalJobUidPassed = internal_job_uid;
      // The model subprocess fires its own Stop hook mid-run. That Stop carries the
      // internal job uid, so it must never schedule another extraction.
      const outcome = await handleRuntimeEvent(
        { key, event_ref: "internal-stop", kind: "turn_completed", internal_job_uid },
        { root, adapter },
      );
      if (outcome.scheduled) internalStopScheduledJobs += 1;
      return { code: 0, stdout: "[]", stderr: "" };
    },
    emit: async () => {},
  });

  await adapter.extract({
    job_uid: "job-1",
    runtime_kind: "claude-code",
    native_session_id: "ns-1",
    source_event_refs: ["stop-marker"],
    binding_uid: binding.binding_uid,
    binding_revision: binding.revision,
    soul_uid: "s1",
    internal_task: true,
  });

  assert.equal(internalJobUidPassed, "job-1", "the adapter tags the model call with the internal job uid");
  assert.equal(internalStopScheduledJobs, 0);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. resume and compact inject current revisions
// ---------------------------------------------------------------------------

test("claude-code: resume and compact inject current revisions", async () => {
  const root = tempDir();
  const soulUid = "s1";
  const sessionId = "ns-1";
  const DELETED_CONTENT = "已删除的旧偏好，不该再注入";
  const CURRENT_CONTENT = "客户要先看真实付费证据，再讨论渠道";

  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "123";
    d.cloud_device_uid = "cdu";
    d.souls[soulUid] = makeSoul(soulUid);
    d.consents["cdu:s1"] = makeConsent("cdu", soulUid);
    d.bindings[`p1\u0000dev-1\u0000claude-code\u0000${sessionId}`] = {
      binding_uid: "b1",
      session_ref: "30000000-0000-4000-8000-000000000001",
      runtime_kind: "claude-code",
      soul_uid: soulUid,
      revision: 1,
      state: "bound",
      profile_id: "p1",
      device_id: "dev-1",
      native_session_id: sessionId,
    };
    const base = {
      kind: "relationship",
      trait: "preference",
      applicability: "客户分析",
      tags: [],
      evidence: "explicit_user_statement",
      verification: "unverified",
      sensitivity: "normal",
      supersedes_uid: null,
      pinned: false,
      source: {
        runtime_kind: "claude-code",
        session_ref: "30000000-0000-4000-8000-000000000001",
        event_ref: "e1",
        occurred_at: "2026-10-20T04:00:00Z",
      },
    };
    d.assets["a1"] = {
      asset_uid: "a1", soul_uid: soulUid, content: CURRENT_CONTENT, state: "active", revision: 1,
      sync_state: "pending_sync", cloud_revision: null, ...base,
    };
    d.assets["a2"] = {
      asset_uid: "a2", soul_uid: soulUid, content: DELETED_CONTENT, state: "deleted", revision: 2,
      sync_state: "pending_sync", cloud_revision: null, ...base,
    };
    d.digest_tombstones[soulUid] = [
      { asset_uid: "a2", soul_uid: soulUid, kind: "relationship", trait: "preference", content_digest: contentDigest(DELETED_CONTENT), revision: 2, state: "deleted", restored_by_uid: null },
    ];
  });

  // Resume / compact re-select the SAME native session binding (no fresh guess).
  const key = keyOf("p1", "dev-1", "claude-code", sessionId);
  const binding = await resolveBinding(key, undefined, { root });
  assert.equal(binding.binding_uid, "b1", "the same native session restores its binding");

  const snap = await readSnap(root, "p1");
  const input = ownerContextInput(snap, soulUid, binding, "整理客户沟通要点", 4096);
  const bundle = selectContext(input);

  // The deleted asset's revision is not injected; the current one is.
  assert.ok(bundle.rendered_text.includes(CURRENT_CONTENT), "the current asset is injected");
  assert.ok(!bundle.rendered_text.includes(DELETED_CONTENT), "the deleted asset is not injected");
  assert.ok(bundle.manifest.every((e) => e.asset_uid !== "a2"), "the deleted asset is absent from the manifest");
  assert.ok(bundle.manifest.some((e) => e.asset_uid === "a1"), "the current asset is in the manifest");

  // The adapter reports delivery with the rendered digest (the hook writes stdout).
  const adapter = createClaudeCodeAdapter({ home: root, readSource: async () => "", invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }), emit: async () => {} });
  const injection = await adapter.inject(bundle);
  assert.equal(injection.delivered, true);
  assert.equal(injection.rendered_sha256.length, 64);

  // A receipt is recorded as "injected" only after actual delivery.
  await recordReceipt(binding, bundle, "injected", { root });
  const after = await readSnap(root, "p1");
  const receipt = Object.values(after.receipts)[0];
  assert.ok(receipt, "a receipt was recorded");
  assert.equal(receipt.stage, "injected");

  // A missing native session id must never write an "unknown" shared binding.
  const ghost = await resolveBinding(keyOf("p1", "dev-1", "claude-code", ""), undefined, { root });
  assert.equal(ghost, null);
  assert.ok(!Object.keys((await readSnap(root, "p1")).bindings).some((k) => k.includes("\u0000\u0000")), "no unknown shared binding was written");

  rmSync(root, { recursive: true, force: true });
});
