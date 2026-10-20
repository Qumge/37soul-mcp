#!/usr/bin/env node
/**
 * Task 4: privacy tests for extraction. Raw conversation text, cwd paths, tool
 * output and secrets must never leave the machine. The scheduler only ever
 * hands the adapter source *refs*; the adapter alone reads raw source, and the
 * model returns a portable asset. The local store, the outbox propose envelope
 * and the HTTP-shaped body it would become must all be free of the fixture's
 * forbidden markers — while the safe preference itself still arrives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openStore } from "../dist/local/store.js";
import { resolveBinding } from "../dist/local/bindings.js";
import { scheduleExtraction } from "../dist/extraction/scheduler.js";
import { assertNoRawEnvelope } from "../dist/assets/validation.js";
import { loadContractFixture } from "./helpers/contract-fixture.mjs";

const { fixture } = loadContractFixture();
const privacy = fixture.privacy_fixture;
const FORBIDDEN = privacy.forbidden_in_37soul_requests;
const RAW_SOURCE = [
  privacy.local_only_inputs.source_message,
  privacy.local_only_inputs.tool_output,
  privacy.local_only_inputs.cwd,
].join("\n");

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "privacy-"));
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

const RANGE = { event_refs: ["turn-opaque-001"], start: 0, end: 4 };

function assertForbiddenAbsent(serialized, label) {
  for (const marker of FORBIDDEN) {
    assert.ok(
      !serialized.includes(marker),
      `${label} must not carry the forbidden marker ${JSON.stringify(marker)}`,
    );
  }
}

function cleanProposal(sessionRef) {
  return {
    kind: "relationship",
    trait: "preference",
    content: privacy.expected_proposal_content,
    applicability: "客户分析与营销方案",
    tags: ["客户分析", "营销"],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    source: {
      runtime_kind: "hermes",
      session_ref: sessionRef,
      event_ref: "turn-opaque-001",
      occurred_at: "2026-10-20T04:00:00Z",
    },
  };
}

test("privacy: raw text, paths, tool output and secrets never reach the outbox, store or HTTP body", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = {
      soul_uid: "s1",
      legacy_host_id: null,
      identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" },
      state: "active",
    };
    d.consents["cdu:s1"] = {
      cloud_device_uid: "cdu",
      soul_uid: "s1",
      revision: 1,
      categories: ["identity", "relationship", "experience"],
      enabled: true,
    };
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  let readSourceCalls = 0;
  // The adapter's `readSource` seam (AdapterDeps.readSource) is the ONLY reader of
  // raw source. The scheduler only hands the adapter source *refs*; it never
  // touches this seam, so the read count here proves the raw text stays inside the
  // adapter and never reaches the store, outbox or HTTP body below.
  const readSource = async (refs) => {
    readSourceCalls += 1;
    assert.ok(Array.isArray(refs), "readSource receives only refs, never raw text");
    return RAW_SOURCE;
  };
  const adapter = {
    runtime_kind: "hermes",
    async probe() {
      return { runtime_kind: "hermes", version: "0", session_id: true, before_request: true };
    },
    async extract(request) {
      assert.ok(Array.isArray(request.source_event_refs), "the adapter receives only refs, never raw text");
      const raw = await readSource(request.source_event_refs);
      assert.ok(raw.includes(privacy.local_only_inputs.source_message), "raw source was actually available");
      // The model returns a clean portable asset; raw markers must not ride along.
      return { proposals: [cleanProposal(binding.session_ref)] };
    },
    async inject() {
      return { delivered: true, rendered_sha256: "sha" };
    },
  };

  await scheduleExtraction(binding, RANGE, { root, adapter });

  assert.equal(readSourceCalls, 1, "raw source is read exactly once, through the readSource seam");

  const store = await openStore(root, "p1");
  const snap = await store.read();
  await store.close();

  // 1. The entire local snapshot (assets, watermarks, outbox, everything) is raw-free.
  assertForbiddenAbsent(JSON.stringify(snap), "local snapshot");

  // 2. The outbox propose envelope that would leave the machine is raw-free...
  const assetOps = Object.values(snap.outbox).filter((op) => op.operation_kind === "asset");
  assert.equal(assetOps.length, 1, "the safe preference is actually queued — blocking everything is not a pass");
  assertForbiddenAbsent(JSON.stringify(assetOps[0].request), "outbox propose envelope");

  // 3. ...and so is the HTTP body it would become (protocol + changes shape, §5).
  const httpBody = JSON.stringify({ protocol: "soul-assets/v1", changes: [assetOps[0].request] });
  assertForbiddenAbsent(httpBody, "HTTP push body");
  assert.doesNotThrow(() => assertNoRawEnvelope(JSON.parse(httpBody)), "the push body carries no raw-envelope fields");

  // 4. The frozen ExtractionRequest in the watermark carries refs only, never raw text.
  const watermark = Object.values(snap.extraction_watermarks)[0];
  assert.ok(watermark, "a watermark was committed");
  assertForbiddenAbsent(JSON.stringify(watermark.request), "frozen extraction request");

  // 5. The safe preference still arrives: the privacy probe must observe the
  //    transformed, portable content — never the raw source.
  assert.ok(httpBody.includes(privacy.expected_proposal_content), "the portable preference arrives intact");

  rmSync(root, { recursive: true, force: true });
});

test("privacy: a failed extraction never falls back to shipping raw text", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = {
      soul_uid: "s1",
      legacy_host_id: null,
      identity_revision: 1,
      identity: { name: "Growth", description: "", character: "", greeting: "" },
      state: "active",
    };
    d.consents["cdu:s1"] = {
      cloud_device_uid: "cdu",
      soul_uid: "s1",
      revision: 1,
      categories: ["relationship"],
      enabled: true,
    };
  });
  const key = keyOf("p1", "dev-1", "hermes", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  const adapter = {
    runtime_kind: "hermes",
    async probe() {
      return { runtime_kind: "hermes", version: "0", session_id: true, before_request: true };
    },
    async extract() {
      return { error: { code: "quota", retryable: true } };
    },
    async inject() {
      return { delivered: true, rendered_sha256: "sha" };
    },
  };

  await scheduleExtraction(binding, RANGE, { root, adapter });

  const store = await openStore(root, "p1");
  const snap = await store.read();
  await store.close();

  assert.equal(
    Object.values(snap.outbox).filter((op) => op.operation_kind === "asset").length,
    0,
    "a refusal enqueues no asset propose",
  );
  assert.equal(Object.keys(snap.assets).length, 0, "a refusal creates no asset");
  assertForbiddenAbsent(JSON.stringify(snap), "snapshot after a refusal");

  rmSync(root, { recursive: true, force: true });
});
