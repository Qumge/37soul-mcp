#!/usr/bin/env node
/**
 * P1: the local source read boundary must be frozen at the completed-turn event.
 *
 * A short completed turn can sit near the end of a transcript that keeps growing
 * while the daemon is busy with an earlier model call. Recomputing a 4MiB tail at
 * drain time pushes the frozen turn out of the window, so two `source_unavailable`
 * results exhaust the budget without a single model call. These tests freeze the
 * byte boundary locally (hook -> writer pointer -> reader) without ever moving raw
 * text or the boundary into the store/outbox.
 *
 * Traces are synthetic temp files; no real HOME, no network, no native model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { openStore } from "../dist/local/store.js";
import { resolveBinding } from "../dist/local/bindings.js";
import { startWriter, sendWriter } from "../dist/local/writer.js";
import {
  MAX_SOURCE_BYTES,
  captureSourcePointer,
  readSourceRefs,
  sourcesDir,
} from "../dist/agentd/source-index.js";
import { createClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { createDaemon } from "../dist/agentd/daemon.js";
import { rangeForEvent, watermarkKey } from "../dist/extraction/scheduler.js";
import { runHookCommand } from "../dist/hook.js";
import { dataRoot } from "../dist/install.js";

const RAW_ONLY = "RAW-TRANSCRIPT-ONLY-MARKER";
const GROWTH = "GROWTH-MARKER";
const FROZEN_TEXT = "客户方案先给真实付费证据，再列渠道假设。";

function tempDir(prefix = "source-boundary-") {
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

function makeConsent(cloudDeviceUid, soulUid) {
  return {
    cloud_device_uid: cloudDeviceUid,
    soul_uid: soulUid,
    revision: 1,
    categories: ["identity", "relationship", "experience"],
    enabled: true,
  };
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

async function readSnap(root, profileId = "p1") {
  const store = await openStore(root, profileId);
  try {
    return await store.read();
  } finally {
    await store.close();
  }
}

const keyOf = (profileId, deviceId, runtimeKind, nativeSessionId) => ({
  profile_id: profileId,
  device_id: deviceId,
  runtime_kind: runtimeKind,
  native_session_id: nativeSessionId,
});

function claudeTurn(prefix, userText) {
  return [
    JSON.stringify({ type: "user", uuid: `${prefix}-u`, parentUuid: null, message: { role: "user", content: userText } }),
    JSON.stringify({ type: "assistant", uuid: `${prefix}-a`, parentUuid: `${prefix}-u`, message: { role: "assistant", content: [{ type: "text", text: "noted" }] } }),
  ].join("\n") + "\n";
}

function growthLine() {
  return `${JSON.stringify({
    type: "user",
    uuid: "growth",
    parentUuid: "target-a",
    message: { role: "user", content: `${GROWTH}-${"x".repeat(MAX_SOURCE_BYTES + 4096)}` },
  })}\n`;
}

function proposal() {
  return {
    kind: "relationship",
    trait: "preference",
    content: FROZEN_TEXT,
    applicability: "客户方案",
    tags: ["客户", "证据"],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
  };
}

function fakeBlocker() {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    started,
    release,
    adapter: {
      runtime_kind: "hermes",
      async probe() {
        return { runtime_kind: "hermes", version: "0", session_id: false, before_request: false };
      },
      async extract() {
        markStarted();
        await gate;
        return { proposals: [] };
      },
      async inject() {
        return { delivered: true, rendered_sha256: "sha" };
      },
    },
  };
}

test("source-boundary: a deferred predecessor + later >4MiB growth cannot evict the frozen turn", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });

  const targetPath = path.join(root, "target.jsonl");
  writeFileSync(targetPath, `${claudeTurn("old", "first turn")}${claudeTurn("target", `我的偏好：${FROZEN_TEXT}\n${RAW_ONLY}`)}`, { mode: 0o600 });

  const blockerKey = keyOf("p1", "dev-1", "hermes", "ns-blocker");
  const targetKey = keyOf("p1", "dev-1", "claude-code", "ns-target");
  const targetBinding = await resolveBinding(targetKey, undefined, { root });
  await resolveBinding(blockerKey, undefined, { root });

  const writer = await startWriter(root);
  const blockerEvent = { key: blockerKey, event_ref: randomUUID(), kind: "checkpoint", internal_job_uid: null };
  const blockerSend = await sendWriter(root, {
    request_uid: randomUUID(), profile_id: "p1", command: "runtime_event", payload: { event: blockerEvent },
  });
  assert.equal(blockerSend.ok, true, "the blocked predecessor is queued");

  const frozenEnd = statSync(targetPath).size;
  const targetEvent = {
    key: targetKey,
    event_ref: randomUUID(),
    kind: "turn_completed",
    source_turn_refs: ["target-u", "target-a"],
    internal_job_uid: null,
  };
  const targetSend = await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: "p1",
    command: "runtime_event",
    payload: { event: targetEvent, source_path: targetPath, source_end_offset: frozenEnd },
  });
  assert.equal(targetSend.ok, true, "the completed turn is queued behind the predecessor");

  const blocker = fakeBlocker();
  let targetCalls = 0;
  let modelInput = "";
  const targetAdapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs, turnRefs) => readSourceRefs(root, refs, turnRefs),
    invoke: async (_runtime, _args, input) => {
      targetCalls += 1;
      modelInput = input;
      return { code: 0, stdout: JSON.stringify({ proposals: [proposal()] }), stderr: "" };
    },
    emit: async () => {},
  });
  const daemon = createDaemon(
    { root, apiBaseUrl: "http://127.0.0.1:0", machineId: "m-1", tokens: {}, home: root },
    { extractAdapters: { hermes: blocker.adapter, "claude-code": targetAdapter } },
  );

  const draining = daemon.drainExtractions();
  await blocker.started;
  appendFileSync(targetPath, growthLine());
  assert.ok(statSync(targetPath).size > frozenEnd + MAX_SOURCE_BYTES, "the transcript grew past the 4MiB tail");
  blocker.release();
  const stats = await draining;
  await writer.close();

  assert.deepEqual(stats, { started: 2, completed: 2, failed: 0 }, "both ranges complete without a source retry");
  assert.equal(targetCalls, 1, "the frozen turn reaches the model exactly once");

  const pointer = JSON.parse(
    readFileSync(path.join(sourcesDir(root), "p1", `${targetEvent.event_ref}.json`), "utf8"),
  );
  assert.equal(pointer.end_offset, frozenEnd, "the pointer freezes the completed-turn byte boundary");
  assert.ok(!JSON.stringify(pointer).includes(GROWTH), "the pointer never carries transcript text");
  assert.ok(!JSON.stringify(pointer).includes(RAW_ONLY), "the pointer never carries raw text");

  const snap = await readSnap(root);
  const wm = snap.extraction_watermarks[watermarkKey(targetBinding, rangeForEvent(targetEvent))];
  assert.ok(wm, "the target watermark exists");
  assert.equal(wm.completed, true, "the target range completes on its first attempt");
  assert.equal(wm.attempts, 1, "no automatic attempt was wasted");

  assert.match(modelInput, new RegExp(FROZEN_TEXT), "the model saw the frozen preference");
  assert.ok(!modelInput.includes(GROWTH), "the model never read the later growth");
  assert.ok(!modelInput.includes("first turn"), "the frozen window stops at the completed turn");

  const assets = Object.values(snap.assets);
  assert.equal(assets.length, 1, "the clean proposal is committed");
  assert.equal(assets[0].content, FROZEN_TEXT);
  assert.equal(Object.values(snap.outbox).filter((op) => op.operation_kind === "asset").length, 1, "the proposal is queued for cloud");

  const serialized = JSON.stringify(snap);
  assert.ok(!serialized.includes(targetPath), "the transcript path stays out of the store");
  assert.ok(!serialized.includes("end_offset"), "the local byte boundary stays out of the store");
  assert.ok(!serialized.includes(GROWTH), "growth text stays out of the store");
  assert.ok(!serialized.includes(RAW_ONLY), "raw transcript text stays out of the store");

  rmSync(root, { recursive: true, force: true });
});

test("source-boundary: a hook Stop freezes the boundary through the real writer and drain", async () => {
  const home = tempDir("source-boundary-hook-");
  const root = dataRoot(home);
  const profileId = "p1";
  const deviceId = "dev-1";
  const sessionId = "boundary-session";
  const transcriptPath = path.join(home, "hook-transcript.jsonl");
  const firstTurn = claudeTurn("hook-1", "first preference");
  const secondTurn = claudeTurn("hook-2", `second preference: ${FROZEN_TEXT}\n${RAW_ONLY}`);
  writeFileSync(transcriptPath, `${firstTurn}${secondTurn}`, { mode: 0o600 });

  await seedProfile(root, profileId, deviceId, (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  writeFileSync(
    path.join(root, "accounts.json"),
    `${JSON.stringify({ "owner-1": { profile_id: profileId, default_soul_uid: "s1", soul_sync_mode: "assets_only" } })}\n`,
    { mode: 0o600 },
  );

  const writer = await startWriter(root);
  const io = { stdout: () => {}, stderr: () => {} };
  const code = await runHookCommand({
    home,
    agentKind: "claude-code",
    event: "Stop",
    fetch: async () => { throw new Error("no repo brief for a Stop event"); },
    stdin: JSON.stringify({
      session_id: sessionId,
      cwd: home,
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
      last_assistant_message: "noted",
    }),
    stdout: io.stdout,
    stderr: io.stderr,
    getGitState: async () => { throw new Error("no repo brief for a Stop event"); },
  });
  await writer.close();
  assert.equal(code, 0);

  const before = await readSnap(root, profileId);
  const watermarks = Object.values(before.extraction_watermarks);
  assert.equal(watermarks.length, 1, "Stop enqueued one extraction range");
  assert.deepEqual(watermarks[0].request.source_turn_refs, ["hook-2-u", "hook-2-a"], "the latest completed turn");

  const eventRef = watermarks[0].request.source_event_refs[0];
  const pointerPath = path.join(sourcesDir(root), profileId, `${eventRef}.json`);
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  assert.equal(pointer.end_offset, statSync(transcriptPath).size, "Stop froze the transcript size it read");
  assert.ok(!JSON.stringify(pointer).includes(FROZEN_TEXT), "the pointer carries a location and boundary only");

  appendFileSync(transcriptPath, growthLine());

  let modelCalls = 0;
  let modelInput = "";
  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs, turnRefs) => readSourceRefs(root, refs, turnRefs),
    invoke: async (_runtime, _args, input) => {
      modelCalls += 1;
      modelInput = input;
      return { code: 0, stdout: JSON.stringify({ proposals: [] }), stderr: "" };
    },
    emit: async () => {},
  });
  const daemon = createDaemon(
    { root, apiBaseUrl: "http://127.0.0.1:0", machineId: "m-1", tokens: {}, home },
    { extractAdapters: { "claude-code": adapter } },
  );
  const stats = await daemon.drainExtractions();

  assert.equal(stats.completed, 1, "the hook-frozen range drains after the transcript grew >4MiB");
  assert.equal(modelCalls, 1, "the model is invoked once, not retried into the ground");
  assert.match(modelInput, /second preference/, "the completed second turn reaches the model");
  assert.ok(!modelInput.includes("first preference"), "the earlier turn stays out of the frozen window");
  assert.ok(!modelInput.includes(GROWTH), "later growth stays out of the frozen window");

  const after = await readSnap(root, profileId);
  const wm = Object.values(after.extraction_watermarks)[0];
  assert.equal(wm.completed, true);
  assert.equal(wm.attempts, 1);
  assert.ok(!JSON.stringify(after).includes(transcriptPath), "the transcript path stays local");
  assert.ok(!JSON.stringify(after).includes("end_offset"), "the byte boundary stays out of the store");

  rmSync(home, { recursive: true, force: true });
});

test("source-boundary: truncation and same-size replacement fail honestly with zero model calls", async () => {
  const root = tempDir();
  const file = path.join(root, "trace.jsonl");
  const keep = claudeTurn("keep", "keep me");
  const tail = JSON.stringify({ type: "assistant", uuid: "tail", parentUuid: "keep-a", message: { role: "assistant", content: [{ type: "text", text: "tail line that will vanish" }] } });
  writeFileSync(file, `${keep}${tail}\n`, { mode: 0o600 });
  const frozenEnd = statSync(file).size;
  const ref = randomUUID();
  await captureSourcePointer(root, "p1", ref, {
    runtime_kind: "claude-code",
    native_session_id: "ns-1",
    path: file,
    captured_at: new Date().toISOString(),
    end_offset: frozenEnd,
  });

  let modelCalls = 0;
  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs, turnRefs) => readSourceRefs(root, refs, turnRefs),
    invoke: async () => { modelCalls += 1; return { code: 0, stdout: JSON.stringify({ proposals: [] }), stderr: "" }; },
    emit: async () => {},
  });
  const request = {
    job_uid: "truncate-1",
    runtime_kind: "claude-code",
    native_session_id: "ns-1",
    source_event_refs: [ref],
    source_turn_refs: ["keep-u", "keep-a"],
    binding_uid: "b",
    binding_revision: 1,
    soul_uid: "s",
    internal_task: true,
  };

  // Truncated below the frozen boundary: the completed refs still exist in the
  // remaining prefix, so reading the *current* tail would silently succeed.
  writeFileSync(file, keep);
  assert.ok(statSync(file).size < frozenEnd);
  assert.equal(await readSourceRefs(root, [ref], ["keep-u", "keep-a"]), "", "a shrunk file is an honest miss");
  assert.deepEqual(
    await adapter.extract(request),
    { error: { code: "source_unavailable", retryable: true } },
    "truncation reports source_unavailable",
  );
  assert.equal(modelCalls, 0, "truncation never invokes the model");

  // Same size, different bytes: the frozen refs are gone.
  writeFileSync(file, "y".repeat(frozenEnd));
  assert.equal(statSync(file).size, frozenEnd);
  assert.equal(await readSourceRefs(root, [ref], ["keep-u", "keep-a"]), "", "a replaced file is an honest miss");
  assert.deepEqual(
    await adapter.extract({ ...request, job_uid: "replace-1" }),
    { error: { code: "source_unavailable", retryable: true } },
    "replacement reports source_unavailable",
  );
  assert.equal(modelCalls, 0, "replacement never invokes the model");

  rmSync(root, { recursive: true, force: true });
});

test("source-boundary: a boundary inside a line or a UTF-8 character keeps completed refs intact", async () => {
  const root = tempDir();
  const file = path.join(root, "partial.jsonl");
  const user = JSON.stringify({ type: "user", uuid: "p-u", parentUuid: null, message: { role: "user", content: "complete user line 中文偏好" } });
  const assistant = JSON.stringify({ type: "assistant", uuid: "p-a", parentUuid: "p-u", message: { role: "assistant", content: [{ type: "text", text: "complete assistant line" }] } });
  const partialLine = JSON.stringify({ type: "user", uuid: "p-late", parentUuid: "p-a", message: { role: "user", content: "LATE-LINE-MARKER 截断" } });
  const full = `${user}\n${assistant}\n${partialLine}\n`;
  writeFileSync(file, full, { mode: 0o600 });

  // Mid-line: the boundary lands inside the third record.
  const lateStart = Buffer.byteLength(`${user}\n${assistant}\n`, "utf8");
  const midLineEnd = lateStart + Math.floor((Buffer.byteLength(partialLine, "utf8") - 2) / 2);
  const midLineRef = randomUUID();
  await captureSourcePointer(root, "p1", midLineRef, {
    runtime_kind: "claude-code", native_session_id: "ns-1", path: file,
    captured_at: new Date().toISOString(), end_offset: midLineEnd,
  });
  const midLineWindow = await readSourceRefs(root, [midLineRef], ["p-u", "p-a"]);
  assert.ok(midLineWindow.includes("complete user line"), "completed user refs survive a mid-line boundary");
  assert.ok(midLineWindow.includes("complete assistant line"), "completed assistant refs survive a mid-line boundary");
  assert.equal(await readSourceRefs(root, [midLineRef], ["p-late"]), "", "the incomplete record is not evidence");
  assert.ok(midLineWindow.length <= MAX_SOURCE_BYTES);

  // Mid-UTF-8: aim the boundary one byte into the first three-byte character.
  const bytes = Buffer.from(full, "utf8");
  const charAt = bytes.indexOf(Buffer.from("截", "utf8"));
  assert.ok(charAt > 0);
  const midCharRef = randomUUID();
  await captureSourcePointer(root, "p1", midCharRef, {
    runtime_kind: "claude-code", native_session_id: "ns-1", path: file,
    captured_at: new Date().toISOString(), end_offset: charAt + 1,
  });
  const midCharWindow = await readSourceRefs(root, [midCharRef], ["p-u", "p-a"]);
  assert.ok(midCharWindow.includes("complete user line"), "refs survive a mid-UTF-8 boundary");
  assert.equal(await readSourceRefs(root, [midCharRef], ["p-late"]), "", "the partial UTF-8 record is not evidence");

  rmSync(root, { recursive: true, force: true });
});

test("source-boundary: a captured pointer defaults its boundary to the capture-time size", async () => {
  const root = tempDir();
  const file = path.join(root, "default.jsonl");
  writeFileSync(file, claudeTurn("default", "DEFAULT-TURN-TEXT"), { mode: 0o600 });
  const capturedAtSize = statSync(file).size;
  const ref = randomUUID();
  await captureSourcePointer(root, "p1", ref, {
    runtime_kind: "claude-code", native_session_id: "ns-1", path: file,
    captured_at: new Date().toISOString(),
  });

  const pointer = JSON.parse(readFileSync(path.join(sourcesDir(root), "p1", `${ref}.json`), "utf8"));
  assert.equal(pointer.end_offset, capturedAtSize, "the pointer records the file size it was captured at");

  appendFileSync(file, growthLine());
  const window = await readSourceRefs(root, [ref], ["default-u", "default-a"]);
  assert.ok(window.includes("DEFAULT-TURN-TEXT"), "growth after capture cannot evict the frozen turn");
  assert.ok(!window.includes(GROWTH));

  rmSync(root, { recursive: true, force: true });
});

test("source-boundary: per-turn pointers keep independent frozen windows after large growth", async () => {
  const root = tempDir();
  const file = path.join(root, "two-turns.jsonl");
  writeFileSync(file, claudeTurn("one", "FIRST-TURN-TEXT"), { mode: 0o600 });
  const firstEnd = statSync(file).size;
  const firstRef = randomUUID();
  await captureSourcePointer(root, "p1", firstRef, {
    runtime_kind: "claude-code", native_session_id: "ns-1", path: file,
    captured_at: new Date().toISOString(), end_offset: firstEnd,
  });

  appendFileSync(file, claudeTurn("two", "SECOND-TURN-TEXT"));
  const secondEnd = statSync(file).size;
  const secondRef = randomUUID();
  await captureSourcePointer(root, "p1", secondRef, {
    runtime_kind: "claude-code", native_session_id: "ns-1", path: file,
    captured_at: new Date().toISOString(), end_offset: secondEnd,
  });

  appendFileSync(file, growthLine());

  const firstWindow = await readSourceRefs(root, [firstRef], ["one-u", "one-a"]);
  assert.ok(firstWindow.includes("FIRST-TURN-TEXT"), "the first turn keeps its own frozen window");
  assert.ok(!firstWindow.includes("SECOND-TURN-TEXT"), "the first window stops at its own boundary");
  assert.ok(!firstWindow.includes(GROWTH), "growth is outside the first window");

  const secondWindow = await readSourceRefs(root, [secondRef], ["two-u", "two-a"]);
  assert.ok(secondWindow.includes("SECOND-TURN-TEXT"), "the second turn keeps its own frozen window");
  assert.ok(!secondWindow.includes(GROWTH), "growth is outside the second window");
  assert.ok(secondWindow.length <= MAX_SOURCE_BYTES, "the second window remains bounded");

  rmSync(root, { recursive: true, force: true });
});
