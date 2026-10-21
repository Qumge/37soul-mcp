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
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClaudeCodeAdapter, completedTurnSourceRefs, renderSourceTurn } from "../dist/adapters/claude-code.js";
import {
  createCodexAdapter,
  CODEX_HOOK_EVENTS,
  inspectCodexTrust,
  writeCodexHookConfig,
  codexCompletedTurnRefs,
  renderCodexTurn,
  buildCodexExtractionInvocation,
} from "../dist/adapters/codex.js";
import {
  createOpenCodeAdapter,
  OPENCODE_PLUGIN_GENERATIONS,
  OPENCODE_PLUGIN_SOURCE,
  openCodePluginGeneration,
  validateOpenCodeGenerations,
  inspectOpenCodePlugin,
  writeOpenCodePlugin,
  opencodeCompletedTurnRefs,
  renderOpenCodeTurn,
  buildOpenCodeExtractionInvocation,
} from "../dist/adapters/opencode.js";
import { openStore } from "../dist/local/store.js";
import { sendWriter, startWriter } from "../dist/local/writer.js";
import { resolveBinding } from "../dist/local/bindings.js";
import { handleRuntimeEvent } from "../dist/extraction/scheduler.js";
import { ownerContextInput, recordReceipt } from "../dist/sync/client.js";
import { selectContext } from "../dist/assets/context.js";
import { contentDigest } from "../dist/assets/protocol.js";
import {
  createHermesAdapter,
  HERMES_PLUGIN_FILENAME,
  HERMES_PLUGIN_SOURCE,
  detectHermesSurface,
  hermesEventSurface,
  hermesProbe,
  inspectHermesPlugin,
  writeHermesPlugin,
  hermesCompletedTurnRefs,
  renderHermesTurn,
  buildHermesExtractionInvocation,
  hermesPluginPath,
} from "../dist/adapters/hermes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const transcriptJsonl = readFileSync(
  path.join(here, "fixtures", "runtimes", "claude-code", "stop-turn.jsonl"),
  "utf8",
);
const codexRolloutJsonl = readFileSync(
  path.join(here, "fixtures", "runtimes", "codex", "turn.jsonl"),
  "utf8",
);
const opencodeTurnJsonl = readFileSync(
  path.join(here, "fixtures", "runtimes", "opencode", "turn.jsonl"),
  "utf8",
);
const hermesTurnJsonl = readFileSync(
  path.join(here, "fixtures", "runtimes", "hermes", "turn.jsonl"),
  "utf8",
);
const hermesGatewayJsonl = readFileSync(
  path.join(here, "fixtures", "runtimes", "hermes", "gateway-events.jsonl"),
  "utf8",
);
const hermesPySource = readFileSync(
  path.join(here, "..", "src", "adapters", "plugins", "hermes.py"),
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
  // branch — even when the sidechain record is written before the main-chain
  // tool_result child — nor the turn_duration system record or the later turn.
  assert.deepEqual(completedTurnSourceRefs(transcriptJsonl), completedTurnRefs);

  const reads = [];
  let modelInput = null;
  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs) => {
      reads.push(refs.slice());
      // The marker ref maps to the raw transcript; the adapter renders the turn
      // locally from that returned text (readSource is hit exactly once).
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
  // and rendered exactly those from the returned transcript (one bounded read).
  assert.equal(reads.length, 1, "raw source is read once through the readSource seam");
  assert.deepEqual(reads[0], ["stop-marker"]);

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

// ---------------------------------------------------------------------------
// Codex (Task 7): untrusted hooks, bounded turn refs, isolated invocation,
// per-session binding, and deleted-asset exclusion on compact refresh.
// ---------------------------------------------------------------------------

test("codex: untrusted hooks expose pending reason and never claim injection/extraction", async () => {
  const root = tempDir("codex-");
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });

  const adapter = createCodexAdapter({
    home,
    readSource: async () => "",
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  });

  const probe = await adapter.probe();
  assert.equal(probe.runtime_kind, "codex");
  assert.equal(probe.version, "0.0.0-unverified");
  assert.equal(probe.structured_extraction, false, "no observed structured extraction capability");
  assert.equal(probe.session_id, false);
  assert.equal(probe.before_request, false);

  // The hook surface is modeled but every event stays UNVERIFIED.
  assert.deepEqual(
    CODEX_HOOK_EVENTS.map((entry) => entry.event),
    ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact", "SessionEnd"],
  );
  assert.ok(CODEX_HOOK_EVENTS.every((entry) => entry.verified === false), "no event may be marked verified");

  // No Codex-authored trust marker: pending, never green.
  assert.deepEqual(inspectCodexTrust(home), { trusted: false, events_seen: false, reason: "pending" });

  // Our own hook-config write is "installed" but must never flip trusted.
  const written = writeCodexHookConfig(home);
  assert.equal(written.installed, true);
  assert.deepEqual(inspectCodexTrust(home), { trusted: false, events_seen: false, reason: "pending" });

  // Untrusted hooks: injection is not claimed.
  const bundle = {
    soul_uid: "10000000-0000-4000-8000-000000000001",
    identity_revision: 1,
    binding_uid: "20000000-0000-4000-8000-000000000001",
    binding_revision: 1,
    manifest: [],
    rendered_text: "[Soul]\n",
    truncated: false,
  };
  const injection = await adapter.inject(bundle);
  assert.equal(injection.delivered, false);
  assert.equal(injection.error, "codex_hooks_untrusted");

  rmSync(root, { recursive: true, force: true });
});

test("codex: official hooks.json is installed; trust is never fabricated", () => {
  const home = tempDir("codex-trust-");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "config.toml"), "[hooks.37soul-hooks]\ntrusted = true\n", { mode: 0o600 });

  // A config.toml marker is not Codex's hook trust store and must never be read as one.
  assert.deepEqual(inspectCodexTrust(home), { trusted: false, events_seen: false, reason: "pending" });

  writeCodexHookConfig(home, { command: "/tmp/37soul" });
  const hooks = JSON.parse(readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
  assert.ok(hooks.hooks.SessionStart, "official SessionStart group exists");
  assert.ok(hooks.hooks.UserPromptSubmit, "official UserPromptSubmit group exists");
  assert.ok(hooks.hooks.Stop, "official Stop group exists");
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /hook --agent codex --event SessionStart/);
  assert.deepEqual(inspectCodexTrust(home), { trusted: false, events_seen: false, reason: "pending" }, "installing is not trusting");

  // A real hook event in the local spool is evidence of execution, not trust.
  mkdirSync(path.join(home, ".37soul", "spool", "codex"), { recursive: true });
  writeFileSync(path.join(home, ".37soul", "spool", "codex", "s.jsonl"), "{}\n", { mode: 0o600 });
  assert.deepEqual(inspectCodexTrust(home), { trusted: false, events_seen: true, reason: "observed" });

  rmSync(home, { recursive: true, force: true });
});

test("codex: structured extraction uses bounded source refs", async () => {
  const root = tempDir("codex-extract-");
  const completedTurnRefs = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

  // The resolver picks the first completed turn only: no injected-context user
  // record, no reasoning/meta/compaction records, and never the later turn.
  assert.deepEqual(codexCompletedTurnRefs(codexRolloutJsonl), {
    session_id: "01a13000-0000-7000-8000-000000000001",
    refs: completedTurnRefs,
  });

  const reads = [];
  let modelInput = null;
  let invokeRuntime = null;
  let invokeJobUid = null;
  let invokeArgs = null;
  const adapter = createCodexAdapter({
    home: root,
    readSource: async (refs) => {
      reads.push(refs.slice());
      // The marker ref maps to the raw rollout; the adapter renders the turn
      // locally from that returned text (readSource is hit exactly once).
      return codexRolloutJsonl;
    },
    invoke: async (runtime, args, input, jobUid) => {
      invokeRuntime = runtime;
      invokeJobUid = jobUid;
      invokeArgs = args;
      modelInput = input;
      return { code: 0, stdout: "[]", stderr: "" };
    },
    emit: async () => {},
  });

  const request = {
    job_uid: "codex-job-1",
    runtime_kind: "codex",
    native_session_id: "01a13000-0000-7000-8000-000000000001",
    source_event_refs: ["rollout-marker"],
    binding_uid: "b1",
    binding_revision: 1,
    soul_uid: "s1",
    internal_task: true,
  };
  const result = await adapter.extract(request);
  assert.deepEqual(result, { proposals: [] });

  // The adapter resolved the opaque marker into the completed turn's ordinals and
  // rendered exactly those from the returned rollout (one bounded read).
  assert.equal(reads.length, 1, "raw source is read once through the readSource seam");
  assert.deepEqual(reads[0], ["rollout-marker"]);

  // The native command is isolated in one builder and invoked only via deps.invoke.
  assert.deepEqual(buildCodexExtractionInvocation(request, "turn text").args, ["exec", "--json", "--skip-git-repo-check", "-s", "read-only"]);
  assert.deepEqual(invokeArgs, ["exec", "--json", "--skip-git-repo-check", "-s", "read-only"]);
  assert.equal(invokeRuntime, "codex", "the native tool is codex");
  assert.equal(invokeJobUid, "codex-job-1", "the model call is tagged with the job uid");

  // The model received only the completed turn's source — no injected context, no
  // later turn — with tool activity summarized through the shared parser.
  assert.ok(modelInput.includes("给 /users 接口加分页"), "the completed turn's user text is present");
  assert.ok(modelInput.includes("先看现在的接口实现"), "the completed turn's assistant text is present");
  assert.ok(modelInput.includes("sed -n '1,40p' app/controllers/users_controller.rb"), "the exec call is summarized");
  assert.ok(modelInput.includes("app/controllers/users_controller.rb"), "the apply_patch call is summarized");
  assert.ok(modelInput.includes("分页参数好了；测试挂了，先看一眼。"), "the final answer is present");
  assert.ok(!modelInput.includes("<environment_context>"), "the injected context is excluded");
  assert.ok(!modelInput.includes("默认 page size 用 20"), "the later turn is excluded");

  rmSync(root, { recursive: true, force: true });
});

test("codex: two native sessions do not share persona", async () => {
  const root = tempDir("codex-sessions-");
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });

  const leftBinding = await resolveBinding(keyOf("p1", "dev-1", "codex", "codex-session-a"), "s1", { root });
  const rightBinding = await resolveBinding(keyOf("p1", "dev-1", "codex", "codex-session-b"), "s2", { root });

  assert.notEqual(leftBinding.soul_uid, rightBinding.soul_uid);
  assert.notEqual(leftBinding.binding_uid, rightBinding.binding_uid);
  assert.equal(leftBinding.native_session_id, "codex-session-a");
  assert.equal(rightBinding.native_session_id, "codex-session-b");

  rmSync(root, { recursive: true, force: true });
});

test("codex: compact refresh excludes deleted assets", async () => {
  const root = tempDir("codex-compact-");
  const soulUid = "s1";
  const sessionId = "codex-session-a";
  const DELETED_CONTENT = "已删除的旧偏好，不该再注入";
  const CURRENT_CONTENT = "客户要先看真实付费证据，再讨论渠道";

  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "123";
    d.cloud_device_uid = "cdu";
    d.souls[soulUid] = makeSoul(soulUid);
    d.consents["cdu:s1"] = makeConsent("cdu", soulUid);
    d.bindings[`p1\u0000dev-1\u0000codex\u0000${sessionId}`] = {
      binding_uid: "b1",
      session_ref: "30000000-0000-4000-8000-000000000002",
      runtime_kind: "codex",
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
        runtime_kind: "codex",
        session_ref: "30000000-0000-4000-8000-000000000002",
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

  // Resume / compact re-select the SAME native codex session binding (no fresh guess).
  const binding = await resolveBinding(keyOf("p1", "dev-1", "codex", sessionId), undefined, { root });
  assert.equal(binding.binding_uid, "b1", "the same native codex session restores its binding");

  const snap = await readSnap(root, "p1");
  const input = ownerContextInput(snap, soulUid, binding, "整理客户沟通要点", 4096);
  const refreshed = selectContext(input);

  assert.ok(refreshed.manifest.some((e) => e.asset_uid === "a1"), "the current asset is in the manifest");
  assert.ok(!refreshed.manifest.some((x) => x.asset_uid === "a2"), "the deleted asset is absent from the manifest");
  assert.ok(refreshed.rendered_text.includes(CURRENT_CONTENT), "the current asset is injected");
  assert.ok(!refreshed.rendered_text.includes(DELETED_CONTENT), "the deleted asset is not injected");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// OpenCode (Task 8): explicit plugin generations, observation-only probe,
// message-completion extraction through the tool model, and isolation of
// internal tasks / session resets.
// ---------------------------------------------------------------------------

test("opencode: unsupported plugin generation is explicit", () => {
  // The supported generations are explicit data: v1 and v2 are distinct surfaces
  // and neither is verified (no authorized live probe).
  assert.deepEqual(Object.keys(OPENCODE_PLUGIN_GENERATIONS).sort(), ["v1", "v2"]);
  assert.ok(
    Object.values(OPENCODE_PLUGIN_GENERATIONS).every((entry) => entry.verified === false),
    "no generation may be marked verified",
  );

  // An installed file declares its own generation; an unknown declaration is an
  // explicit unsupported result, never a guess.
  assert.deepEqual(openCodePluginGeneration('export default { api_generation: "v2" }'), { generation: "v2" });
  assert.deepEqual(openCodePluginGeneration('export default { api_generation: "v1" }'), { generation: "v1" });
  assert.deepEqual(openCodePluginGeneration("export default {}"), { unsupported: true, declared: "" });
  assert.deepEqual(openCodePluginGeneration('export default { api_generation: "v3" }'), { unsupported: true, declared: "v3" });

  // V1/V2 are never mixed in one configuration: a mixed set fails explicitly.
  assert.deepEqual(validateOpenCodeGenerations(["v2"]), { generation: "v2" });
  assert.deepEqual(validateOpenCodeGenerations(["v1", "v2"]), { unsupported: true, reason: "mixed_generation" });
  assert.deepEqual(validateOpenCodeGenerations(["v3"]), { unsupported: true, reason: "unknown_generation" });
  assert.deepEqual(validateOpenCodeGenerations([]), { unsupported: true, reason: "unknown_generation" });

  // The single exported invocation builder never mixes generations: exactly one
  // generation's args, and an unknown generation is an explicit unsupported result.
  const request = {
    job_uid: "j",
    runtime_kind: "opencode",
    native_session_id: "ns",
    source_event_refs: [],
    binding_uid: "b",
    binding_revision: 1,
    soul_uid: "s",
    internal_task: true,
  };
  assert.deepEqual(buildOpenCodeExtractionInvocation(request, "turn", "v3"), { unsupported: true, declared: "v3" });
  assert.deepEqual(buildOpenCodeExtractionInvocation(request, "turn", "v1").args, ["run", "--format", "json"]);
  assert.deepEqual(buildOpenCodeExtractionInvocation(request, "turn", "v2").args, ["run", "--format", "json", "--standalone"]);
});

test("opencode: message completion extracts through tool model", async () => {
  const root = tempDir("opencode-extract-");
  const completedTurnRefs = ["req-1", "m1", "t1", "m2"];

  // Observation-only host: the bridge may fire events, but no model call has been
  // authorized, so structured extraction stays false — observing events is never
  // structured extraction.
  const observationAdapter = createOpenCodeAdapter({
    home: root,
    readSource: async () => "",
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  });
  const observationOnlyProbe = await observationAdapter.probe();
  assert.equal(observationOnlyProbe.structured_extraction, false);
  assert.equal(observationOnlyProbe.version, "0.0.0-unverified");
  assert.equal(observationOnlyProbe.session_id, false);

  // The resolver picks the first completed turn only: the first request boundary
  // plus its messages/tools, and never the later turn.
  assert.deepEqual(opencodeCompletedTurnRefs(opencodeTurnJsonl), {
    session_id: "oc-0001",
    refs: completedTurnRefs,
  });

  const reads = [];
  let modelInput = null;
  let invokeRuntime = null;
  let invokeJobUid = null;
  let invokeArgs = null;
  const adapter = createOpenCodeAdapter({
    home: root,
    readSource: async (refs) => {
      reads.push(refs.slice());
      // The marker ref maps to the raw transcript; the adapter renders the turn
      // locally from that returned text (readSource is hit exactly once).
      return opencodeTurnJsonl;
    },
    invoke: async (runtime, args, input, jobUid) => {
      invokeRuntime = runtime;
      invokeJobUid = jobUid;
      invokeArgs = args;
      modelInput = input;
      return { code: 0, stdout: "[]", stderr: "" };
    },
    emit: async () => {},
  });

  const request = {
    job_uid: "oc-job-1",
    runtime_kind: "opencode",
    native_session_id: "oc-0001",
    source_event_refs: ["oc-marker"],
    binding_uid: "b1",
    binding_revision: 1,
    soul_uid: "s1",
    internal_task: true,
  };
  const result = await adapter.extract(request);
  assert.deepEqual(result, { proposals: [] });

  // The adapter resolved the opaque marker into the completed turn's record ids and
  // rendered exactly those from the returned transcript (one bounded read).
  assert.equal(reads.length, 1, "raw source is read once through the readSource seam");
  assert.deepEqual(reads[0], ["oc-marker"]);

  // The native command is isolated in one builder and invoked only via deps.invoke.
  assert.deepEqual(invokeArgs, ["run", "--format", "json", "--standalone"]);
  assert.equal(invokeRuntime, "opencode", "the native tool is opencode");
  assert.equal(invokeJobUid, "oc-job-1", "the model call is tagged with the job uid");

  // The model received only the completed turn's source — the request prompt, the
  // assistant messages and the summarized tool call — never the later turn.
  assert.ok(modelInput.includes("给 /users 接口加分页"), "the completed turn's user prompt is present");
  assert.ok(modelInput.includes("给查询层加上 limit/offset"), "the completed turn's assistant text is present");
  assert.ok(modelInput.includes("sed -n '1,40p' app/controllers/users_controller.rb"), "the tool input is summarized");
  assert.ok(!modelInput.includes("默认 page size 用 20"), "the later turn is excluded");

  rmSync(root, { recursive: true, force: true });
});

test("opencode: internal task and reset stay isolated", async () => {
  const root = tempDir("opencode-reset-");
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });

  // A reset to a new native session must not inherit the old soul (never by cwd,
  // never by guessing): with two souls and no default, the binding is null.
  await resolveBinding(keyOf("p1", "dev-1", "opencode", "oc-original"), "s1", { root });
  const resetBinding = await resolveBinding(keyOf("p1", "dev-1", "opencode", "oc-reset-new"), undefined, { root });
  assert.equal(resetBinding, null);

  // Internal message-completed events must never schedule another extraction.
  const key = keyOf("p1", "dev-1", "opencode", "oc-original");
  const binding = await resolveBinding(key, "s1", { root });
  let internalJobUidPassed = null;
  let internalMessageScheduledJobs = 0;
  const adapter = createOpenCodeAdapter({
    home: root,
    readSource: async () => opencodeTurnJsonl,
    invoke: async (runtime, args, input, internal_job_uid) => {
      internalJobUidPassed = internal_job_uid;
      // The plugin bridge fires its own message.completed mid-run. That event carries
      // the internal job uid, so it must never schedule another extraction.
      const outcome = await handleRuntimeEvent(
        { key, event_ref: "internal-message", kind: "turn_completed", internal_job_uid },
        { root, adapter },
      );
      if (outcome.scheduled) internalMessageScheduledJobs += 1;
      return { code: 0, stdout: "[]", stderr: "" };
    },
    emit: async () => {},
  });

  await adapter.extract({
    job_uid: "job-1",
    runtime_kind: "opencode",
    native_session_id: "oc-original",
    source_event_refs: ["oc-marker"],
    binding_uid: binding.binding_uid,
    binding_revision: binding.revision,
    soul_uid: "s1",
    internal_task: true,
  });

  assert.equal(internalJobUidPassed, "job-1", "the adapter tags the model call with the internal job uid");
  assert.equal(internalMessageScheduledJobs, 0);

  // The plugin bridge reports distinct honest doctor states, never a generic failure.
  assert.deepEqual(inspectOpenCodePlugin(root), { status: "not_installed", generation: null, declared: "" });
  writeOpenCodePlugin(root);
  assert.deepEqual(inspectOpenCodePlugin(root), { status: "not_loaded", generation: "v2", declared: "v2" });

  rmSync(root, { recursive: true, force: true });
});

test("opencode: the plugin bridge spawns only the local hook command and makes no network call", () => {
  const source = OPENCODE_PLUGIN_SOURCE;

  // Exactly ONE spawn in the whole bridge, and that spawn is the fixed-argv hook
  // command (no shell, never the host runtime). Count, not presence: a second
  // `spawn(someVar, ...)` or a different argv must fail.
  assert.equal(
    (source.match(/spawn\s*\(/g) ?? []).length,
    1,
    "exactly one spawn in the bridge",
  );
  assert.equal(
    (source.match(/spawn\s*\(\s*launcher\(\)\s*,\s*\[\s*"hook"\s*,\s*"--agent"\s*,\s*"opencode"\s*,\s*"--event"\s*,\s*event\s*\]/g) ?? []).length,
    1,
    "the single spawn is exactly the hook command",
  );
  assert.ok(!/spawn\s*\(\s*["'`]/.test(source), "no shell-string spawn");

  // No network surface anywhere in the bridge (module imports included).
  assert.ok(!/\b(fetch|http|https|net|tls|http2|dns|dgram|ws|undici|socket)\b/.test(source), "no network call");

  // The payload is bounded and the wait has a short timeout (never hangs the host).
  assert.ok(source.includes("MAX_BRIDGE_PAYLOAD_BYTES"), "payload is bounded");
  assert.ok(source.includes("BRIDGE_TIMEOUT_MS"), "a short timeout bounds the wait");
});

test("opencode: an oversized bridge payload is still valid JSON and the bridge stays live", async () => {
  const root = tempDir("opencode-bridge-");
  const pluginFile = path.join(root, "37soul-soul.mjs");
  writeFileSync(pluginFile, OPENCODE_PLUGIN_SOURCE, { mode: 0o600 });
  const mod = await import(pathToFileURL(pluginFile).href);

  // An oversized payload must become a still-valid envelope, never a sliced byte
  // string that the receiver would drop as "stdin was not valid JSON".
  const overflowText = mod.boundedPayload("Stop", {
    session_id: "s",
    big: Array(4000).fill("1234567890"),
  });
  const overflow = JSON.parse(overflowText);
  assert.equal(overflow.truncated, true, "oversized payload is marked truncated");
  assert.equal(overflow.payload, null, "the payload is dropped, not sliced");
  assert.equal(overflow.agent, "opencode", "the envelope keeps the agent");
  assert.equal(overflow.event, "Stop", "the envelope keeps the event");

  // A small payload is bounded per-field and never truncated. Hook stdin needs
  // the native fields at the top level, not nested under another object.
  const small = JSON.parse(mod.boundedPayload("Stop", { session_id: "s", last_assistant_message: "hi" }));
  assert.equal(small.truncated, undefined, "small payload is not truncated");
  assert.equal(small.session_id, "s");

  // End-to-end: the real OpenCode plugin hook forwards through the fixed argv to
  // the local hook and stays live with valid JSON on stdin.
  const capture = path.join(root, "captured.json");
  const launcher = path.join(root, "37soul");
  writeFileSync(launcher, "#!/bin/sh\ncat > \"$SOUL37_TEST_CAPTURE\"\n", { mode: 0o755 });
  process.env.SOUL37_LAUNCHER = launcher;
  process.env.SOUL37_TEST_CAPTURE = capture;
  process.env.SOUL37_HOME = root;
  let contextHook;
  const ctx = {
    location: { directory: root },
    session: {
      hook: async (name, fn) => { if (name === "context") contextHook = fn; return { dispose: async () => {} }; },
      context: async () => [],
    },
    event: { subscribe: async function* () {} },
  };
  try {
    await mod.default.setup(ctx);
    const system = [];
    await contextHook({
      sessionID: "s",
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hello" }] }],
      system,
    });
  } finally {
    delete process.env.SOUL37_LAUNCHER;
    delete process.env.SOUL37_TEST_CAPTURE;
    delete process.env.SOUL37_HOME;
  }
  const received = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(received.session_id, "s");
  assert.match(received.transcript_path, /opencode-sessions\/s\.jsonl/);
  assert.equal(received.agent, "opencode");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hermes (Task 9): modeled CLI + Python bridge; gateway events are never CLI
// capability, reset never inherits, compact reloads active revisions, and an
// interrupted internal task stays pending without recursion.
// ---------------------------------------------------------------------------

test("hermes: CLI events drive structured extraction", async () => {
  const root = tempDir("hermes-extract-");
  const completedTurnRefs = ["u1", "a1", "t1", "a2"];

  // A gateway-only event stream must never be judged as CLI capability: a probe
  // built from gateway events alone reports structured_extraction false, and the
  // version stays unverified (0.21.0 is P0-observed, never a supported version).
  assert.equal(hermesEventSurface(hermesGatewayJsonl), "gateway");
  const gatewayOnlyProbe = hermesProbe("gateway");
  assert.equal(gatewayOnlyProbe.structured_extraction, false);
  assert.equal(gatewayOnlyProbe.version, "0.0.0-unverified");

  // The resolver picks the first completed turn only: the first user_message plus
  // its assistant/tool records, and never the later turn.
  assert.deepEqual(hermesCompletedTurnRefs(hermesTurnJsonl), {
    session_id: "h-0001",
    refs: completedTurnRefs,
  });

  const reads = [];
  let modelInput = null;
  let invokeRuntime = null;
  let invokeJobUid = null;
  let invokeArgs = null;
  const adapter = createHermesAdapter({
    home: root,
    readSource: async (refs) => {
      reads.push(refs.slice());
      // The marker ref maps to the raw transcript; the adapter renders the turn
      // locally from that returned text (readSource is hit exactly once).
      return hermesTurnJsonl;
    },
    invoke: async (runtime, args, input, jobUid) => {
      invokeRuntime = runtime;
      invokeJobUid = jobUid;
      invokeArgs = args;
      modelInput = input;
      return { code: 0, stdout: "[]", stderr: "" };
    },
    emit: async () => {},
  });

  const request = {
    job_uid: "h-job-1",
    runtime_kind: "hermes",
    native_session_id: "h-0001",
    source_event_refs: ["h-marker"],
    binding_uid: "b1",
    binding_revision: 1,
    soul_uid: "s1",
    internal_task: true,
  };
  const result = await adapter.extract(request);
  assert.deepEqual(result, { proposals: [] });

  // The adapter resolved the opaque marker into the completed turn's record ids and
  // rendered exactly those from the returned transcript (one bounded read).
  assert.equal(reads.length, 1, "raw source is read once through the readSource seam");
  assert.deepEqual(reads[0], ["h-marker"]);

  // The native command is isolated in one builder and invoked only via deps.invoke.
  assert.deepEqual(buildHermesExtractionInvocation(request, "turn text").args, ["chat", "--query-file", "-", "--oneshot", "-Q", "--ignore-rules", "--source", "tool"]);
  assert.deepEqual(invokeArgs, ["chat", "--query-file", "-", "--oneshot", "-Q", "--ignore-rules", "--source", "tool"]);
  assert.equal(invokeRuntime, "hermes", "the native tool is hermes");
  assert.equal(invokeJobUid, "h-job-1", "the model call is tagged with the job uid");

  // The model received only the completed turn's source — never the later turn.
  assert.ok(modelInput.includes("给 /users 接口加分页"), "the completed turn's user text is present");
  assert.ok(modelInput.includes("先看现在的接口实现"), "the completed turn's assistant text is present");
  assert.ok(modelInput.includes("sed -n '1,40p' app/controllers/users_controller.rb"), "the tool input is summarized");
  assert.ok(modelInput.includes("给查询层加上 limit/offset"), "the final answer is present");
  assert.ok(!modelInput.includes("默认 page size 用 20"), "the later turn is excluded");

  rmSync(root, { recursive: true, force: true });
});

test("hermes: reset creates a new binding decision", async () => {
  const root = tempDir("hermes-reset-");
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });

  // A reset to a new native session must not inherit the old soul (never by cwd,
  // never by guessing): with two souls and no default, the binding is null.
  await resolveBinding(keyOf("p1", "dev-1", "hermes", "h-original"), "s1", { root });
  const resetBinding = await resolveBinding(keyOf("p1", "dev-1", "hermes", "h-reset-new"), undefined, { root });
  assert.equal(resetBinding, null);

  rmSync(root, { recursive: true, force: true });
});

test("hermes: compact reloads active revisions", async () => {
  const root = tempDir("hermes-compact-");
  const soulUid = "s1";
  const sessionId = "h-session-a";
  const DELETED_CONTENT = "已删除的旧偏好，不该再注入";
  const CURRENT_CONTENT = "客户要先看真实付费证据，再讨论渠道";

  await seedProfile(root, "p1", "dev-1", (d) => {
    d.owner_id = "123";
    d.cloud_device_uid = "cdu";
    d.souls[soulUid] = makeSoul(soulUid);
    d.consents["cdu:s1"] = makeConsent("cdu", soulUid);
    d.bindings[`p1\u0000dev-1\u0000hermes\u0000${sessionId}`] = {
      binding_uid: "b1",
      session_ref: "30000000-0000-4000-8000-000000000003",
      runtime_kind: "hermes",
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
        runtime_kind: "hermes",
        session_ref: "30000000-0000-4000-8000-000000000003",
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

  // Compact re-selects the SAME native hermes session binding (no fresh guess).
  const binding = await resolveBinding(keyOf("p1", "dev-1", "hermes", sessionId), undefined, { root });
  assert.equal(binding.binding_uid, "b1", "the same native hermes session restores its binding");

  const snap = await readSnap(root, "p1");
  const input = ownerContextInput(snap, soulUid, binding, "整理客户沟通要点", 4096);
  const compactBundle = selectContext(input);

  // The bundle/manifest after compaction equals the live active set derived from
  // the snapshot the test itself built (never a literal): the deleted asset's
  // revision is absent, the current one is present.
  const currentActiveManifest = Object.values(snap.assets)
    .filter((asset) => asset.state === "active")
    .map((asset) => ({ asset_uid: asset.asset_uid, revision: asset.revision }));
  assert.deepEqual(compactBundle.manifest, currentActiveManifest);
  assert.ok(compactBundle.rendered_text.includes(CURRENT_CONTENT), "the current asset is injected");
  assert.ok(!compactBundle.rendered_text.includes(DELETED_CONTENT), "the deleted asset is not injected");

  rmSync(root, { recursive: true, force: true });
});

test("hermes: interrupted internal task stays pending", async () => {
  const root = tempDir("hermes-interrupt-");
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.souls["s2"] = makeSoul("s2");
  });

  const key = keyOf("p1", "dev-1", "hermes", "h-original");
  const binding = await resolveBinding(key, "s1", { root });

  // Deliver a turn_completed runtime event through the writer (the hook/bridge
  // path). The writer writes a pending watermark and reserves the job uid WITHOUT
  // running the model — the worker that would run it is interrupted before it can
  // commit or fail, so the watermark stays pending.
  const writer = await startWriter(root);
  let runtimeEventResult;
  try {
    runtimeEventResult = await sendWriter(root, {
      request_uid: "req-interrupt-1",
      profile_id: "p1",
      command: "runtime_event",
      payload: {
        event: { key, event_ref: "10000000-0000-4000-8000-0000000000ee", kind: "turn_completed", internal_job_uid: null },
      },
    });
  } finally {
    await writer.close();
  }
  assert.equal(runtimeEventResult.ok, true, "the runtime event is delivered to the writer");
  const jobUid = runtimeEventResult.result?.job_uid;
  assert.ok(typeof jobUid === "string" && jobUid !== "", "a job uid is reserved for the interrupted job");

  const snap = await readSnap(root, "p1");
  const interruptedJob = Object.values(snap.extraction_watermarks).find(
    (wm) => wm.request && wm.request.binding_uid === binding.binding_uid,
  );
  assert.ok(interruptedJob, "the interrupted job's watermark is written");
  assert.equal(interruptedJob.state, "pending");
  assert.equal(interruptedJob.attempts, 0, "enqueue does not spend a model attempt");

  // The interrupted job's own internal emissions carry the job uid and can never
  // schedule another extraction (no recursion, no second attempt, no raw upload).
  const adapter = createHermesAdapter({
    home: root,
    readSource: async () => hermesTurnJsonl,
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  });
  const internalOutcome = await handleRuntimeEvent(
    { key, event_ref: "internal-stop", kind: "turn_completed", internal_job_uid: jobUid },
    { root, adapter },
  );
  assert.equal(internalOutcome.scheduled, false, "an internal event never schedules");

  const after = await readSnap(root, "p1");
  const stillPending = Object.values(after.extraction_watermarks).find(
    (wm) => wm.request && wm.request.binding_uid === binding.binding_uid,
  );
  assert.equal(stillPending.state, "pending", "the interrupted job stays pending");
  assert.equal(stillPending.attempts, 0, "no recursive attempt bumped the budget");

  rmSync(root, { recursive: true, force: true });
});

test("hermes: the python bridge spawns only the local hook command and makes no network call", () => {
  const source = HERMES_PLUGIN_SOURCE;

  // The canonical .py file and the embedded install source are byte-identical
  // (no drift between the reviewable file and what install writes).
  assert.equal(hermesPySource, source, "the embedded bridge source matches hermes.py");

  // Exactly ONE spawn in the whole bridge, and that spawn is the fixed-argv hook
  // command (no shell, never the host runtime). Count, not presence: a second
  // subprocess.Popen/run call or a shell=True must fail.
  assert.equal(
    (source.match(/subprocess\.(Popen|run)\s*\(/g) ?? []).length,
    1,
    "exactly one subprocess spawn in the bridge",
  );
  assert.ok(
    source.includes('[_launcher(), "hook", "--agent", "hermes", "--event", event]'),
    "the single spawn is exactly the hook command",
  );
  assert.ok(!/shell\s*=\s*True/.test(source), "no shell=True");

  // Standard library only — positively: extract every module the bridge imports and
  // assert the set is a subset of the allowed stdlib modules (a blacklist would let
  // a third-party module like numpy through). The network-keyword check stays too.
  const importedModules = new Set();
  for (const match of source.matchAll(/\bimport\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    importedModules.add(match[1]);
  }
  for (const match of source.matchAll(/\bfrom\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/g)) {
    importedModules.add(match[1].split(".")[0]);
  }
  assert.ok(importedModules.size > 0, "the bridge's imports are extracted");
  assert.ok(
    [...importedModules].every((name) => ["Path", "hashlib", "json", "os", "pathlib", "subprocess", "sys"].includes(name)),
    `standard library only — got: ${[...importedModules].join(", ")}`,
  );
  assert.ok(!/\b(urllib|http|https|socket|requests|aiohttp|ftplib|smtplib)\b/.test(source), "no network call");

  // The payload is bounded and the wait has a short timeout (never hangs the host),
  // and every error path still returns 0 (main always exits 0).
  assert.ok(source.includes("TIMEOUT_SECONDS"), "a short timeout bounds the wait");
  assert.ok(source.includes("sys.exit(main())"), "the CLI entry always exits through main()");
  assert.ok(source.includes("capture_output=True"), "the local hook output is captured, never printed raw");
});

test("hermes: official shell hook writes a real turn trace and returns injected context", async () => {
  const root = tempDir("hermes-shell-hook-");
  const pyFile = path.join(root, "37soul-hook.py");
  writeFileSync(pyFile, hermesPySource, { mode: 0o600 });
  const capture = path.join(root, "captured.json");
  const launcher = path.join(root, "37soul");
  writeFileSync(
    launcher,
    "#!/bin/sh\ncat > \"$SOUL37_TEST_CAPTURE\"\nprintf '%s\\n' '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"real context\"}}'\n",
    { mode: 0o755 },
  );
  const env = { ...process.env, SOUL37_LAUNCHER: launcher, SOUL37_TEST_CAPTURE: capture, SOUL37_HOME: root };
  const { spawnSync } = await import("node:child_process");
  const pre = spawnSync("python3", [pyFile, "pre_llm_call"], {
    input: JSON.stringify({ session_id: "s1", user_message: "remember this preference", turn_id: "t1", cwd: root }),
    encoding: "utf8",
    env,
  });
  assert.equal(pre.status, 0);
  assert.deepEqual(JSON.parse(pre.stdout), { context: "real context" });
  const traceFile = path.join(root, ".37soul", "hermes-sessions", "s1.jsonl");
  assert.match(readFileSync(traceFile, "utf8"), /remember this preference/);

  const post = spawnSync("python3", [pyFile, "post_llm_call"], {
    input: JSON.stringify({ session_id: "s1", user_message: "remember this preference", assistant_response: "noted", turn_id: "t1", cwd: root }),
    encoding: "utf8",
    env,
  });
  assert.equal(post.status, 0);
  assert.match(readFileSync(traceFile, "utf8"), /noted/);
  const stopPayload = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(stopPayload.session_id, "s1");
  assert.equal(stopPayload.last_assistant_message, "noted");
  assert.match(stopPayload.transcript_path, /hermes-sessions\/s1\.jsonl/);

  rmSync(root, { recursive: true, force: true });
});

test("hermes: probe and doctor report gateway-only honestly, never as CLI", async () => {
  const root = tempDir("hermes-surface-");

  // A gateway-only config is detected explicitly.
  mkdirSync(path.join(root, ".hermes"), { recursive: true });
  writeFileSync(
    path.join(root, ".hermes", "config.yaml"),
    "transport: gateway\ngateway:\n  url: https://gateway.example\n",
    { mode: 0o600 },
  );
  assert.equal(detectHermesSurface(root), "gateway");
  assert.deepEqual(inspectHermesPlugin(root), { status: "gateway_only", surface: "gateway" });

  // The adapter's probe stays all-false and the gateway-only extract refuses
  // instead of invoking the model through a gateway.
  const adapter = createHermesAdapter({
    home: root,
    readSource: async () => hermesTurnJsonl,
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  });
  const probe = await adapter.probe();
  assert.equal(probe.structured_extraction, false);
  assert.equal(probe.runtime_kind, "hermes");
  const extraction = await adapter.extract({
    job_uid: "h-gw-1",
    runtime_kind: "hermes",
    native_session_id: "h-gw-session",
    source_event_refs: ["h-marker"],
    binding_uid: "b1",
    binding_revision: 1,
    soul_uid: "s1",
    internal_task: true,
  });
  assert.deepEqual(extraction, { error: { code: "gateway_only", retryable: false } });

  // A CLI-shaped config (any non-gateway config) is "cli"; no config is "none".
  writeFileSync(path.join(root, ".hermes", "config.yaml"), "transport: cli\n", { mode: 0o600 });
  assert.equal(detectHermesSurface(root), "cli");
  rmSync(path.join(root, ".hermes", "config.json"), { force: true });
  assert.equal(detectHermesSurface(root), "cli", "an existing .hermes dir without a gateway marker is modeled as cli");

  // Installing the bridge and inspecting again stays observation_only (never green).
  const written = writeHermesPlugin(root);
  assert.equal(written.installed, true);
  assert.deepEqual(inspectHermesPlugin(root), { status: "observation_only", surface: "cli" });
  assert.equal(readFileSync(hermesPluginPath(root), "utf8"), HERMES_PLUGIN_SOURCE);
  assert.ok(HERMES_PLUGIN_FILENAME.endsWith(".py"), "the managed bridge is a Python file");

  // A gateway-shaped event stream must refuse even when config detection is
  // inconclusive (the surface here is CLI): the stream classifier guards
  // extraction too, so a gateway record is never fed to a model invocation.
  const streamAdapter = createHermesAdapter({
    home: root,
    readSource: async () => hermesGatewayJsonl,
    invoke: async () => {
      throw new Error("the model must not be invoked for a gateway stream");
    },
    emit: async () => {},
  });
  const streamRefusal = await streamAdapter.extract({
    job_uid: "h-gw-stream-1",
    runtime_kind: "hermes",
    native_session_id: "h-gw-stream-session",
    source_event_refs: ["h-gw-marker"],
    binding_uid: "b1",
    binding_revision: 1,
    soul_uid: "s1",
    internal_task: true,
  });
  assert.deepEqual(streamRefusal, { error: { code: "gateway_only", retryable: false } });

  rmSync(root, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// M1: a completed turn that resolves to zero refs is a retryable source
// failure, never a permanent silent "nothing worth remembering" success.
// ---------------------------------------------------------------------------

test("every adapter: zero-ref source is source_unavailable and never reaches the model", async () => {
  const cases = [
    ["claude-code", createClaudeCodeAdapter],
    ["codex", createCodexAdapter],
    ["opencode", createOpenCodeAdapter],
    ["hermes", createHermesAdapter],
  ];

  for (const [runtimeKind, make] of cases) {
    const root = tempDir(`zero-ref-${runtimeKind}-`);
    let invocations = 0;
    const adapter = make({
      home: root,
      readSource: async () => "",
      invoke: async () => {
        invocations += 1;
        return { code: 0, stdout: "[]", stderr: "" };
      },
      emit: async () => {},
    });

    const result = await adapter.extract({
      job_uid: `job-${runtimeKind}`,
      runtime_kind: runtimeKind,
      native_session_id: "ns-1",
      source_event_refs: ["marker"],
      binding_uid: "b1",
      binding_revision: 1,
      soul_uid: "s1",
      internal_task: true,
    });

    assert.deepEqual(
      result,
      { error: { code: "source_unavailable", retryable: true } },
      `${runtimeKind} zero-ref source is source_unavailable`,
    );
    assert.equal(invocations, 0, `${runtimeKind} never invokes the model on zero refs`);

    rmSync(root, { recursive: true, force: true });
  }
});
