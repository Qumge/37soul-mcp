/**
 * Task 1: freeze the shared soul-assets/v1 contract types, the context selector,
 * payload validation and the runtime probe interface.
 *
 * The golden expectations come from the vendored shared fixture — never from
 * per-test hand-written expected values. Cases are iterated dynamically so a
 * coordinated fixture bump is picked up without editing this file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { selectContext } from "../dist/assets/context.js";
import { validateProposedAsset, assertNoRawEnvelope, ValidationError } from "../dist/assets/validation.js";
import { contentDigest, LIMITS } from "../dist/assets/protocol.js";
import { probeRuntime } from "../dist/adapters/probe.js";

import { loadContractFixture, contextCases, classificationCases, SECTION_NAMES } from "./helpers/contract-fixture.mjs";
import { createFakeAdapter, RUNTIME_KINDS } from "./helpers/fake-runtime.mjs";

const { fixture } = loadContractFixture();

// ---------------------------------------------------------------------------
// Fixture integrity + loader
// ---------------------------------------------------------------------------

test("contract: vendored fixture is byte-identical (declared protocol + SHA-256 verified by loader)", () => {
  assert.equal(fixture.protocol, "soul-assets/v1");
  const loaded = loadContractFixture();
  assert.equal(loaded.sha256, loaded.source.sha256);
});

test("contract: loader iterates every shared section dynamically", () => {
  for (const name of SECTION_NAMES) {
    assert.ok(name in fixture, `missing section ${name}`);
    assert.ok(fixture[name] !== undefined, `section ${name} present`);
  }
  const cases = contextCases(fixture);
  assert.ok(cases.length >= 5, "context_cases are read from the fixture, not hard-coded");
  for (const c of cases) {
    assert.ok(c.input.soul.soul_uid, `${c.name}: soul present`);
    assert.ok(c.input.binding.binding_uid, `${c.name}: seed.binding attached`);
    assert.ok(Array.isArray(c.input.assets), `${c.name}: assets present`);
  }
});

test("contract: shared selection cases match golden manifest/order/truncation/bytes/sha", () => {
  for (const c of contextCases(fixture)) {
    const actual = selectContext(c.input);
    assert.deepEqual(actual.manifest, c.expected.manifest, `manifest for ${c.name}`);
    assert.equal(actual.truncated, c.expected.truncated, `truncated for ${c.name}`);
    assert.equal(actual.rendered_text, c.expected.rendered_text, `rendered_text for ${c.name}`);
    assert.equal(
      Buffer.byteLength(actual.rendered_text, "utf8"),
      c.expected.rendered_utf8_bytes,
      `utf8 bytes for ${c.name}`,
    );
    assert.equal(
      createHash("sha256").update(actual.rendered_text).digest("hex"),
      c.expected.rendered_sha256,
      `sha256 for ${c.name}`,
    );
    assert.ok(
      Buffer.byteLength(actual.rendered_text, "utf8") <= c.expected.rendered_utf8_bytes_max,
      `${c.name}: stays within budget`,
    );
  }
});

test("contract: content_digest matches every server-generated seed digest", () => {
  for (const asset of fixture.seed.assets) {
    if (typeof asset.content_digest === "string") {
      assert.equal(contentDigest(asset.content), asset.content_digest, `digest for ${asset.asset_uid}`);
    }
  }
});

test("context: sex and age are rendered into the identity line when present", () => {
  const soul = {
    soul_uid: "10000000-0000-4000-8000-000000000001",
    legacy_host_id: null,
    identity_revision: 1,
    identity: {
      name: "Growth", description: "", character: "", greeting: "",
      sex: "female", age: 29,
    },
    state: "active",
  };
  const binding = {
    binding_uid: "20000000-0000-4000-8000-000000000001",
    session_ref: "s", runtime_kind: "hermes", soul_uid: soul.soul_uid,
    revision: 1, state: "bound",
  };
  const actual = selectContext({ soul, binding, assets: [], taskHint: "", budgetBytes: 4096 });
  assert.match(actual.rendered_text, /"sex":"female"/);
  assert.match(actual.rendered_text, /"age":29/);
});

// ---------------------------------------------------------------------------
// Context selection rules
// ---------------------------------------------------------------------------

test("context: Unicode budget never splits a code point", () => {
  const unicode = contextCases(fixture).find((c) => c.name === "unicode_budget");
  assert.ok(unicode, "fixture must contain the unicode_budget case");

  const actual = selectContext(unicode.input);
  // Identity-only section must encode to exactly the 128-byte budget with whole
  // code points (never a dangling surrogate / partial character).
  assert.equal(unicode.input.budgetBytes, LIMITS.budgetMin);
  assert.ok(Buffer.byteLength(actual.rendered_text, "utf8") <= LIMITS.budgetMin);
  assert.ok(Buffer.byteLength(actual.rendered_text, "utf8") <= Math.min(LIMITS.identityBudgetMax, LIMITS.budgetMin));
  assert.equal(actual.rendered_text, unicode.expected.rendered_text);
  assert.equal(createHash("sha256").update(actual.rendered_text).digest("hex"), unicode.expected.rendered_sha256);
});

test("context: exact asset boundary matches golden bytes", () => {
  const boundary = contextCases(fixture).find((c) => c.name === "exact_asset_boundary");
  assert.ok(boundary, "fixture must contain the exact_asset_boundary case");

  const actual = selectContext(boundary.input);
  // The whole bundle (identity + one relationship, header included) encodes to
  // exactly the requested budget — the second asset is skipped atomically.
  assert.equal(Buffer.byteLength(actual.rendered_text, "utf8"), boundary.input.budgetBytes);
  assert.equal(actual.truncated, true);
  assert.deepEqual(actual.manifest, boundary.expected.manifest);
  assert.equal(createHash("sha256").update(actual.rendered_text).digest("hex"), boundary.expected.rendered_sha256);
});

test("context: budget is clamped to 128..16384 with 16384 as default", () => {
  const base = contextCases(fixture).find((c) => c.name === "active_only_and_relevance");
  const mk = (budgetBytes) => ({ ...base.input, budgetBytes });

  assert.equal(selectContext(mk(1)).rendered_text, selectContext(mk(128)).rendered_text, "sub-minimum clamps up to 128");
  assert.equal(selectContext(mk(undefined)).rendered_text, base.expected.rendered_text, "default budget is 16384");
  // Explicit over-maximum budget renders the same untruncated bundle.
  assert.equal(selectContext(mk(999999)).truncated, false);
});

test("context: all matching tombstones must point to active replacement", () => {
  const blocked = contextCases(fixture).find((c) => c.name === "digest_tombstone_blocks_local_auto_active");
  const restored = contextCases(fixture).find((c) => c.name === "explicit_restore_overrides_current_tombstones");
  assert.ok(blocked && restored, "fixture must contain both tombstone cases");

  // A tombstone with restored_by_uid=null suppresses the same-digest active asset.
  assert.deepEqual(selectContext(blocked.input).manifest, []);
  // Only when every matching tombstone points at the active UID is it released.
  assert.deepEqual(
    selectContext(restored.input).manifest,
    [{ asset_uid: "40000000-0000-4000-8000-000000000008", revision: 1 }],
  );
});

test("context: quarantine excludes only unconfirmed proposal", () => {
  const mkAsset = (uid, content) => ({
    asset_uid: uid,
    soul_uid: "10000000-0000-4000-8000-000000000001",
    kind: "relationship",
    trait: "preference",
    content,
    applicability: "x",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state: "active",
    revision: 1,
    supersedes_uid: null,
    pinned: false,
    source: { runtime_kind: "hermes", session_ref: "s", event_ref: "e", occurred_at: "2026-10-20T04:00:00Z" },
  });
  const soul = {
    soul_uid: "10000000-0000-4000-8000-000000000001",
    legacy_host_id: null,
    identity_revision: 1,
    identity: { name: "N", description: "", character: "", greeting: "" },
    state: "active",
  };
  const binding = {
    binding_uid: "20000000-0000-4000-8000-000000000001",
    session_ref: "s",
    runtime_kind: "hermes",
    soul_uid: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    state: "bound",
  };
  const proposal = mkAsset("40000000-0000-4000-8000-0000000000aa", "客户分析");
  const confirmed = mkAsset("40000000-0000-4000-8000-0000000000bb", "客户分析");

  const both = selectContext({ soul, assets: [proposal, confirmed], taskHint: "客户分析", binding });
  assert.deepEqual(both.manifest.map((m) => m.asset_uid), [proposal.asset_uid, confirmed.asset_uid]);

  const quarantined = selectContext({
    soul,
    assets: [proposal, confirmed],
    taskHint: "客户分析",
    binding,
    quarantinedAssetUids: [proposal.asset_uid],
  });
  assert.deepEqual(quarantined.manifest.map((m) => m.asset_uid), [confirmed.asset_uid]);
});

test("context: relationships cap at 8 and order by pinned, score, revision, uid", () => {
  const soul = {
    soul_uid: "s",
    legacy_host_id: null,
    identity_revision: 1,
    identity: { name: "N", description: "", character: "", greeting: "" },
    state: "active",
  };
  const binding = {
    binding_uid: "b",
    session_ref: "s",
    runtime_kind: "hermes",
    soul_uid: "s",
    revision: 1,
    state: "bound",
  };
  const mk = (uid, { pinned = false, content = "", revision = 1 } = {}) => ({
    asset_uid: uid,
    soul_uid: "s",
    kind: "relationship",
    trait: "preference",
    content,
    applicability: "",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state: "active",
    revision,
    supersedes_uid: null,
    pinned,
    source: { runtime_kind: "hermes", session_ref: "s", event_ref: "e", occurred_at: "2026-10-20T04:00:00Z" },
  });

  // taskHint "alpha beta" -> relevance words ["alpha", "beta"].
  const assets = [
    mk("r-a", { content: "alpha" }), //            score 1
    mk("r-b", { content: "alpha beta" }), //       score 2
    mk("r-c", { content: "alpha", revision: 9 }), // score 1, rev 9
    mk("r-d", { content: "alpha", revision: 9 }), // score 1, rev 9, uid d > c
    mk("r-p", { pinned: true, content: "" }), //   pinned first
    mk("r-1", { content: "", revision: 5 }),
    mk("r-2", { content: "", revision: 3 }),
    mk("r-3", { content: "", revision: 7 }),
    mk("r-4", { content: "", revision: 1 }),
    mk("r-5", { content: "", revision: 2 }),
  ];
  const out = selectContext({ soul, assets, taskHint: "alpha beta", binding });
  assert.deepEqual(
    out.manifest.map((m) => m.asset_uid),
    ["r-p", "r-b", "r-c", "r-d", "r-a", "r-3", "r-1", "r-2"],
  );
  assert.equal(out.manifest.length, LIMITS.relationshipMax, "relationships are capped at 8");
});

test("context: experiences only include pinned or matched, cap at 4, render after relationships", () => {
  const soul = {
    soul_uid: "s",
    legacy_host_id: null,
    identity_revision: 1,
    identity: { name: "N", description: "", character: "", greeting: "" },
    state: "active",
  };
  const binding = {
    binding_uid: "b",
    session_ref: "s",
    runtime_kind: "hermes",
    soul_uid: "s",
    revision: 1,
    state: "bound",
  };
  const rel = {
    asset_uid: "rel-1",
    soul_uid: "s",
    kind: "relationship",
    trait: "preference",
    content: "alpha",
    applicability: "",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state: "active",
    revision: 1,
    supersedes_uid: null,
    pinned: false,
    source: { runtime_kind: "hermes", session_ref: "s", event_ref: "e", occurred_at: "2026-10-20T04:00:00Z" },
  };
  const exp = (uid, { pinned = false, content = "" } = {}) => ({
    asset_uid: uid,
    soul_uid: "s",
    kind: "experience",
    trait: "fact",
    content,
    applicability: "",
    tags: [],
    evidence: "inference",
    verification: "unverified",
    sensitivity: "normal",
    state: "active",
    revision: 1,
    supersedes_uid: null,
    pinned,
    source: { runtime_kind: "hermes", session_ref: "s", event_ref: "e", occurred_at: "2026-10-20T04:00:00Z" },
  });
  const assets = [
    exp("x-unmatched", { content: "" }), // excluded: not pinned, not matched
    exp("x-m1", { content: "alpha" }),
    exp("x-m2", { content: "beta" }),
    exp("x-m3", { content: "alpha beta" }),
    exp("x-m4", { content: "alpha" }),
    exp("x-p", { pinned: true, content: "" }),
  ];
  const out = selectContext({ soul, assets: [rel, ...assets], taskHint: "alpha beta", binding });
  const uids = out.manifest.map((m) => m.asset_uid);
  assert.equal(uids[0], "rel-1", "relationship renders before experiences");
  assert.ok(!uids.includes("x-unmatched"), "unmatched, unpinned experience is excluded");
  assert.ok(uids.includes("x-p"), "pinned experience is included");
  const experienceUids = uids.slice(1);
  assert.ok(experienceUids.length <= LIMITS.experienceMax, "experiences are capped at 4");
});

// ---------------------------------------------------------------------------
// Payload validation + raw envelope rejection
// ---------------------------------------------------------------------------

test("contract: raw envelope rejected at any nesting level", () => {
  const forbidden = ["events", "transcript", "tool_output", "cwd", "files"];
  const valid = fixture.requests.push_preference;
  assert.doesNotThrow(() => assertNoRawEnvelope(valid), "valid request passes");

  for (const field of forbidden) {
    assert.throws(() => assertNoRawEnvelope({ ...valid, [field]: [{ text: "RAW" }] }), ValidationError, `${field} top-level`);
    const inPayload = structuredClone(valid);
    inPayload.changes[0].payload[field] = "RAW";
    assert.throws(() => assertNoRawEnvelope(inPayload), ValidationError, `${field} in payload`);
    const inSource = structuredClone(valid);
    inSource.changes[0].payload.source[field] = "RAW";
    assert.throws(() => assertNoRawEnvelope(inSource), ValidationError, `${field} in source`);
  }

  assert.throws(() => assertNoRawEnvelope(fixture.requests.reject_raw_envelope), ValidationError);
});

test("contract: validateProposedAsset accepts valid shared payloads and rejects invalid ones", () => {
  // Every classification case with a proposed payload must validate.
  for (const c of classificationCases(fixture)) {
    if (c.proposedPayload !== null) {
      const result = validateProposedAsset(c.proposedPayload);
      assert.equal(result.kind, c.proposedPayload.kind, `kind for ${c.name}`);
      assert.equal(result.content, c.proposedPayload.content, `content for ${c.name}`);
    }
  }

  // The wire propose payload is valid; a nested non-source field in source is not.
  const propose = fixture.requests.push_preference.changes[0].payload;
  assert.doesNotThrow(() => validateProposedAsset(propose));
  assert.throws(
    () => validateProposedAsset(fixture.requests.reject_nested_raw_source.changes[0].payload),
    ValidationError,
    "nested raw source field is rejected",
  );

  const base = () => structuredClone(propose);
  const invalid = {
    "unknown kind": () => { const v = base(); v.kind = "memory"; return v; },
    "experience must use trait fact": () => { const v = base(); v.kind = "experience"; v.trait = "preference"; return v; },
    "oversized relationship content": () => { const v = base(); v.content = "字".repeat(LIMITS.relationshipContentMaxCodePoints + 1); return v; },
    "oversized tag": () => { const v = base(); v.tags = ["字".repeat(LIMITS.tagMaxCodePoints + 1)]; return v; },
    "too many tags": () => { const v = base(); v.tags = Array.from({ length: LIMITS.tagsMax + 1 }, (_, i) => `t${i}`); return v; },
    "legacy runtime_kind": () => { const v = base(); v.source.runtime_kind = "legacy"; return v; },
    "empty event_ref": () => { const v = base(); v.source.event_ref = ""; return v; },
    "non-string content": () => { const v = base(); v.content = 42; return v; },
  };
  for (const [label, mutate] of Object.entries(invalid)) {
    assert.throws(() => validateProposedAsset(mutate()), ValidationError, label);
  }
});

test("contract: every length limit is enforced exactly-at and one-past (code points)", () => {
  const base = () => structuredClone(fixture.requests.push_preference.changes[0].payload);
  // Each field-limited limit is driven with a non-ASCII code point ("字" = 1 code
  // point) so the code-point accounting (not UTF-16 units) is what is asserted.
  const atMost = (label, mutateAt, mutatePast) => {
    assert.doesNotThrow(() => validateProposedAsset(mutateAt()), `${label} exactly-at passes`);
    assert.throws(() => validateProposedAsset(mutatePast()), ValidationError, `${label} one-past rejected`);
  };
  const CP = "字";

  atMost(
    "relationship content (200 code points)",
    () => { const v = base(); v.kind = "relationship"; v.trait = "preference"; v.content = CP.repeat(LIMITS.relationshipContentMaxCodePoints); return v; },
    () => { const v = base(); v.kind = "relationship"; v.trait = "preference"; v.content = CP.repeat(LIMITS.relationshipContentMaxCodePoints + 1); return v; },
  );

  atMost(
    "experience content (4000 code points)",
    () => { const v = base(); v.kind = "experience"; v.trait = "fact"; v.content = CP.repeat(LIMITS.experienceContentMaxCodePoints); return v; },
    () => { const v = base(); v.kind = "experience"; v.trait = "fact"; v.content = CP.repeat(LIMITS.experienceContentMaxCodePoints + 1); return v; },
  );

  atMost(
    "applicability (500 code points)",
    () => { const v = base(); v.applicability = CP.repeat(LIMITS.applicabilityMaxCodePoints); return v; },
    () => { const v = base(); v.applicability = CP.repeat(LIMITS.applicabilityMaxCodePoints + 1); return v; },
  );

  atMost(
    "tags count (8 items)",
    () => { const v = base(); v.tags = Array.from({ length: LIMITS.tagsMax }, (_, i) => `t${i}`); return v; },
    () => { const v = base(); v.tags = Array.from({ length: LIMITS.tagsMax + 1 }, (_, i) => `t${i}`); return v; },
  );

  atMost(
    "tag code points (32 each)",
    () => { const v = base(); v.tags = [CP.repeat(LIMITS.tagMaxCodePoints)]; return v; },
    () => { const v = base(); v.tags = [CP.repeat(LIMITS.tagMaxCodePoints + 1)]; return v; },
  );

  atMost(
    "event_ref (128 code points)",
    () => { const v = base(); v.source.event_ref = CP.repeat(LIMITS.eventRefMaxCodePoints); return v; },
    () => { const v = base(); v.source.event_ref = CP.repeat(LIMITS.eventRefMaxCodePoints + 1); return v; },
  );
});

// ---------------------------------------------------------------------------
// Runtime probe interface
// ---------------------------------------------------------------------------

test("probe: probeRuntime returns the adapter's structured probe result", async () => {
  for (const runtime_kind of RUNTIME_KINDS) {
    const adapter = createFakeAdapter(runtime_kind);
    const probe = await probeRuntime(adapter);
    assert.equal(probe.runtime_kind, runtime_kind);
    assert.equal(typeof probe.version, "string");
    for (const flag of ["session_id", "before_request", "structured_extraction", "internal_marker", "resume", "compact", "interrupt"]) {
      assert.equal(typeof probe[flag], "boolean", `${runtime_kind}.${flag}`);
    }
  }
});

test("probe: runtime_kind mismatch between adapter and probe is rejected", async () => {
  const adapter = createFakeAdapter("claude-code", { probe: { runtime_kind: "hermes" } });
  await assert.rejects(() => probeRuntime(adapter), /runtime_kind mismatch/);
});

test("probe: fake adapter proves bounded source scope, structured result and local receipt", async () => {
  const adapter = createFakeAdapter("codex");
  const extraction = await adapter.extract({
    job_uid: "offline-1",
    runtime_kind: "codex",
    native_session_id: "offline-session",
    source_event_refs: ["turn-offline-001"],
    binding_uid: "b",
    binding_revision: 1,
    soul_uid: "s",
    internal_task: true,
  });
  assert.deepEqual(extraction, { proposals: [] });

  const bundle = {
    soul_uid: "s",
    identity_revision: 1,
    binding_uid: "b",
    binding_revision: 1,
    manifest: [],
    rendered_text: "[Soul]\n",
    truncated: false,
  };
  const injection = await adapter.inject(bundle);
  assert.equal(injection.delivered, true);
  assert.equal(injection.rendered_sha256, createHash("sha256").update(bundle.rendered_text, "utf8").digest("hex"));
});
