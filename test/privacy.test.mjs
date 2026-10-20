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
import { selectContext } from "../dist/assets/context.js";
import { ownerContextInput, recordReceipt, syncOnce } from "../dist/sync/client.js";
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

/** A fake HttpFetch that captures every request so a test can assert nothing leaks. */
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
    const { status, body: resBody, headers = {} } = response;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      body: { cancel: async () => {} },
      json: async () => resBody,
      text: async () => JSON.stringify(resBody),
    };
  };
  http.requests = requests;
  return http;
}

async function readSnap(root, profileId = "p1") {
  const store = await openStore(root, profileId);
  try {
    return await store.read();
  } finally {
    await store.close();
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

test("privacy: native ids prompts and rendered text never reach HTTP", async () => {
  const root = tempDir();
  const NATIVE_ID = "ns-native-private-2026";
  const PROMPT = "PRIVATE-CORE-PROMPT-DO-NOT-SHIP";
  const RENDERED = "RENDERED-TEXT-DO-NOT-SHIP";
  const CONTENT = "分析客户时，先给真实付费证据，再讨论渠道。";
  const SESSION = "30000000-0000-4000-8000-000000000001";

  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "123";
    d.cloud_device_uid = "cdu";
    d.souls["s1"] = {
      soul_uid: "s1",
      legacy_host_id: 7,
      identity_revision: 1,
      identity: { name: "Growth", description: "", character: PROMPT, greeting: "" },
      state: "active",
    };
    d.consents["cdu:s1"] = {
      cloud_device_uid: "cdu", soul_uid: "s1", revision: 1,
      categories: ["identity", "relationship", "experience"], enabled: true,
    };
    d.bindings[`p1\u0000dev-1\u0000hermes\u0000${NATIVE_ID}`] = {
      binding_uid: "b1", session_ref: SESSION, runtime_kind: "hermes", soul_uid: "s1",
      revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: NATIVE_ID,
    };
    d.assets["a1"] = {
      asset_uid: "a1", soul_uid: "s1", kind: "relationship", trait: "preference",
      content: CONTENT, applicability: "客户分析", tags: [], evidence: "explicit_user_statement",
      verification: "unverified", sensitivity: "normal", state: "active", revision: 1,
      supersedes_uid: null, pinned: false,
      source: { runtime_kind: "hermes", session_ref: SESSION, event_ref: "e1", occurred_at: "2026-10-20T04:00:00Z" },
      sync_state: "pending_sync", cloud_revision: null,
    };
    d.outbox["op-1"] = {
      operation_id: "op-1", operation_kind: "asset",
      request: {
        change_id: "a1", operation: "propose", soul_uid: "s1", asset_uid: "a1",
        base_revision: 0, actor: "model", binding_uid: "b1", binding_revision: 1,
        payload: {
          kind: "relationship", trait: "preference", content: CONTENT,
          applicability: "客户分析", tags: [], evidence: "explicit_user_statement",
          verification: "unverified", sensitivity: "normal",
          source: { runtime_kind: "hermes", session_ref: SESSION, event_ref: "e1", occurred_at: "2026-10-20T04:00:00Z" },
        },
      },
      predecessor_operation_ids: [],
    };
  });

  const http = fakeHttp((req) => {
    const p = new URL(req.url).pathname;
    if (req.method === "POST" && p === "/api/v1/me/soul_sync/push") {
      return { status: 200, body: { protocol: "soul-assets/v1", results: [] } };
    }
    if (req.method === "GET" && p === "/api/v1/me/soul_sync/pull") {
      return { status: 200, body: { protocol: "soul-assets/v1", events: [], next_cursor: null, has_more: false } };
    }
    return { status: 500, body: {} };
  });

  await syncOnce("p1", http, {
    root,
    token: "test-token",
    baseUrl: "https://fake.test",
    backoff: { sleep: async () => {} },
  });

  const wire = http.requests.map((r) => `${r.method} ${r.url} ${JSON.stringify(r.body)}`).join("\n");
  assert.ok(!wire.includes(NATIVE_ID), "the native session id never reaches HTTP");
  assert.ok(!wire.includes(PROMPT), "the private identity prompt never reaches HTTP");
  assert.ok(!wire.includes(RENDERED), "rendered text never reaches HTTP");
  assert.ok(wire.includes(CONTENT), "the portable preference still flows (not a silent no-op)");

  // Receipts are local-only and carry rendered_sha256, never the rendered text itself.
  const snap0 = await readSnap(root);
  const binding = Object.values(snap0.bindings)[0];
  await recordReceipt(
    binding,
    { rendered_text: RENDERED, manifest: [{ asset_uid: "a1", revision: 1 }] },
    "downloaded",
    { root },
  );
  const snap = await readSnap(root);
  const receipt = Object.values(snap.receipts)[0];
  assert.ok(receipt, "a receipt was recorded");
  assert.equal(receipt.rendered_sha256.length, 64, "the receipt carries a SHA-256 digest");
  assert.ok(!JSON.stringify(snap.receipts).includes(RENDERED), "receipts never store the rendered text");
  assert.ok(!JSON.stringify(snap.receipts).includes(NATIVE_ID), "receipts never store a native id");

  rmSync(root, { recursive: true, force: true });
});

test("privacy: owner pull uses private identity without other users assets", async () => {
  const root = tempDir();
  const PRIVATE_NAME = "OwnerPrivateName";
  const OTHER_SECRET = "OTHER-USERS-SECRET-FACT";

  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "123";
    d.cloud_device_uid = "cdu";
    d.souls["s1"] = {
      soul_uid: "s1", legacy_host_id: 7, identity_revision: 1,
      identity: { name: PRIVATE_NAME, description: "private core", character: "core", greeting: "" },
      state: "active",
    };
    d.souls["s2"] = {
      soul_uid: "s2", legacy_host_id: 8, identity_revision: 1,
      identity: { name: "AnotherUserSoul", description: "", character: "", greeting: "" },
      state: "active",
    };
    d.consents["cdu:s1"] = { cloud_device_uid: "cdu", soul_uid: "s1", revision: 1, categories: ["identity"], enabled: true };
    d.bindings["p1\u0000dev-1\u0000hermes\u0000ns-1"] = {
      binding_uid: "b1", session_ref: "30000000-0000-4000-8000-000000000001", runtime_kind: "hermes",
      soul_uid: "s1", revision: 1, state: "bound", profile_id: "p1", device_id: "dev-1", native_session_id: "ns-1",
    };
    const assetBase = {
      kind: "relationship", trait: "preference", applicability: "", tags: [],
      evidence: "explicit_user_statement", verification: "unverified", sensitivity: "normal",
      state: "active", revision: 1, supersedes_uid: null, pinned: false,
      source: { runtime_kind: "hermes", session_ref: "30000000-0000-4000-8000-000000000001", event_ref: "e1", occurred_at: "2026-10-20T04:00:00Z" },
      sync_state: "synced", cloud_revision: 1,
    };
    d.assets["a1"] = { asset_uid: "a1", soul_uid: "s1", content: "owner fact", ...assetBase };
    d.assets["b1"] = { asset_uid: "b1", soul_uid: "s2", content: OTHER_SECRET, ...assetBase };
  });

  const snap = await readSnap(root);
  const binding = snap.bindings["p1\u0000dev-1\u0000hermes\u0000ns-1"];
  const input = ownerContextInput(snap, "s1", binding, "task", 4096);

  assert.equal(input.soul.identity.name, PRIVATE_NAME, "the owner pull uses the private identity");
  assert.equal("public_identity" in input.soul, false, "no public projection replaces the private identity");
  assert.ok(input.assets.every((a) => a.soul_uid === "s1"), "other souls' assets never enter the owner's context");
  assert.ok(!JSON.stringify(input.assets).includes(OTHER_SECRET), "other users' content is absent from the input");

  const bundle = selectContext(input);
  assert.ok(bundle.rendered_text.includes(PRIVATE_NAME), "the private identity is what gets injected");
  assert.ok(!bundle.rendered_text.includes(OTHER_SECRET), "other users' content is never injected");

  rmSync(root, { recursive: true, force: true });
});
