#!/usr/bin/env node
/**
 * Task 10c: the local path-pointer source index (privacy-preserving raw-transcript
 * source).
 *
 * Until this module, nothing mapped a hook's opaque random `event_ref` to the host's
 * raw transcript bytes, so `createExtractAdapters`' `readSource` returned "" and every
 * adapter short-circuited to `{ proposals: [] }` — extraction was inert end-to-end.
 * The index closes that gap with path-only pointers (mode 0600, never transcript
 * text): a pointer record is `{runtime_kind, native_session_id, path, captured_at}`,
 * the path is accepted only when absolute + existing + regular, reading is bounded
 * (4 MiB prefix) and local, and the directory is pruned (newest 32 per session, 7-day
 * age).
 *
 * Everything runs against temp dirs — no real HOME, no network, no spawned runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  MAX_POINTERS_PER_SESSION,
  MAX_SOURCE_BYTES,
  captureSourcePointer,
  extractTranscriptPath,
  pruneSourcePointers,
  readSourceRefs,
  sourcesDir,
  validateTranscriptPath,
} from "../dist/agentd/source-index.js";
import { openStore } from "../dist/local/store.js";
import { resolveBinding } from "../dist/local/bindings.js";
import { startWriter, sendWriter } from "../dist/local/writer.js";
import {
  drainPendingExtractions,
  rangeForEvent,
  watermarkKey,
} from "../dist/extraction/scheduler.js";
import { createClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { createExtractAdapters } from "../dist/agentd/native-invoker.js";
import { uninstall } from "../dist/install.js";

function tempDir(prefix = "source-index-") {
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

function pointerFile(root, profileId, eventRef) {
  return path.join(sourcesDir(root), profileId, `${eventRef}.json`);
}

const TURN_TEXT = "I always keep my promise to water the plants.";

// Production event refs are randomUUID(); the writer command requires a UUID, so the
// writer-driven tests use realistic refs. Direct captureSourcePointer unit tests keep
// short names (they exercise the pointer mechanics, not the writer gate).
const REF_SRC = "10000000-0000-4000-8000-000000000001";
const REF_REL = "10000000-0000-4000-8000-000000000002";
const REF_MISSING = "10000000-0000-4000-8000-000000000003";
const REF_NOFIELD = "10000000-0000-4000-8000-000000000004";
const REF_PRUNED = "10000000-0000-4000-8000-000000000005";
const REF_NOLOC = "10000000-0000-4000-8000-000000000006";
const REF_INTERNAL = "10000000-0000-4000-8000-000000000007";

// ---------------------------------------------------------------------------
// field extraction + path validation (verbatim, never fabricated)
// ---------------------------------------------------------------------------

test("source-index: extractTranscriptPath accepts only the verbatim fields and never fabricates", () => {
  assert.equal(extractTranscriptPath({ transcript_path: "/a/b.jsonl" }), "/a/b.jsonl");
  assert.equal(extractTranscriptPath({ rollout_path: "/a/b.jsonl" }), "/a/b.jsonl");
  assert.equal(extractTranscriptPath({ rolloutPath: "/a/b.jsonl" }), "/a/b.jsonl");
  assert.equal(extractTranscriptPath({ transcriptPath: "/a/b.jsonl" }), "/a/b.jsonl");
  // `source_path` is the internal field the assets-mode hook re-emits into the writer.
  assert.equal(extractTranscriptPath({ source_path: "/a/b.jsonl" }), "/a/b.jsonl");

  assert.equal(extractTranscriptPath({ unrelated: "/a/b.jsonl" }), null, "no fabricated location");
  assert.equal(extractTranscriptPath(null), null);
  assert.equal(extractTranscriptPath("x"), null);
  assert.equal(extractTranscriptPath({ transcript_path: "" }), null);
  assert.equal(extractTranscriptPath({ transcript_path: 42 }), null);
  assert.equal(extractTranscriptPath({ transcript_path: "   " }), null);
});

test("source-index: validateTranscriptPath accepts only an absolute existing regular file", async () => {
  const root = tempDir();
  const file = path.join(root, "t.jsonl");
  writeFileSync(file, "hello\n");
  mkdirSync(path.join(root, "adir"));

  assert.equal(await validateTranscriptPath(file), file);
  assert.equal(await validateTranscriptPath("t.jsonl"), null, "relative paths are never guessed from cwd");
  assert.equal(await validateTranscriptPath(path.join(root, "missing.jsonl")), null);
  assert.equal(await validateTranscriptPath(path.join(root, "adir")), null, "a directory is not a file");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pointer capture + privacy + resolution
// ---------------------------------------------------------------------------

test("source-index: capture writes a 0600 pointer with the path only, and readSourceRefs resolves it", async () => {
  const root = tempDir();
  const transcriptPath = path.join(root, "transcript.jsonl");
  writeFileSync(transcriptPath, `${TURN_TEXT}\n`, { mode: 0o600 });

  await captureSourcePointer(root, "p1", "evt-1", {
    runtime_kind: "claude-code",
    native_session_id: "ns-1",
    path: transcriptPath,
    captured_at: new Date().toISOString(),
  });

  const pointer = pointerFile(root, "p1", "evt-1");
  assert.equal(statSync(pointer).mode & 0o777, 0o600, "pointer is private (0600)");
  const content = readFileSync(pointer, "utf8");
  assert.ok(content.includes(transcriptPath), "the pointer records the location");
  assert.ok(!content.includes("water the plants"), "the pointer never records conversation text");

  assert.equal(await readSourceRefs(root, ["evt-1"]), `${TURN_TEXT}\n`, "the ref resolves to the transcript prefix");

  rmSync(root, { recursive: true, force: true });
});

test("source-index: a missing pointer, empty refs, or a gone file resolve to \"\" without error", async () => {
  const root = tempDir();
  assert.equal(await readSourceRefs(root, ["nope"]), "", "no pointer -> empty source");
  assert.equal(await readSourceRefs(root, []), "");
  assert.equal(await readSourceRefs(root, [null, 42, "nope"]), "");

  // A pointer whose underlying transcript was deleted is skipped, not fatal.
  const gone = path.join(root, "gone.jsonl");
  writeFileSync(gone, "bye\n");
  await captureSourcePointer(root, "p1", "evt-gone", {
    runtime_kind: "claude-code",
    native_session_id: "ns-1",
    path: gone,
    captured_at: new Date().toISOString(),
  });
  rmSync(gone, { force: true });
  assert.equal(await readSourceRefs(root, ["evt-gone"]), "", "a dangling pointer yields empty source");

  rmSync(root, { recursive: true, force: true });
});

test("source-index: refs resolve in order and the first resolvable one wins", async () => {
  const root = tempDir();
  const a = path.join(root, "a.jsonl");
  const b = path.join(root, "b.jsonl");
  writeFileSync(a, "AAA");
  writeFileSync(b, "BBB");
  await captureSourcePointer(root, "p1", "evt-a", { runtime_kind: "claude-code", native_session_id: "ns-1", path: a, captured_at: new Date().toISOString() });
  await captureSourcePointer(root, "p1", "evt-b", { runtime_kind: "claude-code", native_session_id: "ns-1", path: b, captured_at: new Date().toISOString() });

  assert.equal(await readSourceRefs(root, ["missing", "evt-a", "evt-b"]), "AAA", "first resolvable ref wins");

  rmSync(root, { recursive: true, force: true });
});

test("source-index: reads at most one bounded 4 MiB prefix", async () => {
  const root = tempDir();
  const big = path.join(root, "big.jsonl");
  writeFileSync(big, Buffer.alloc(MAX_SOURCE_BYTES + 128, "x"));
  await captureSourcePointer(root, "p1", "evt-big", { runtime_kind: "claude-code", native_session_id: "ns-1", path: big, captured_at: new Date().toISOString() });

  const prefix = await readSourceRefs(root, ["evt-big"]);
  assert.equal(prefix.length, MAX_SOURCE_BYTES, "only the bounded prefix is returned");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// pruning (bound + age)
// ---------------------------------------------------------------------------

test("source-index: keeps at most the newest N pointers per session", async () => {
  const root = tempDir();
  const t = path.join(root, "t.jsonl");
  writeFileSync(t, "x");
  for (let i = 0; i < MAX_POINTERS_PER_SESSION + 5; i += 1) {
    await captureSourcePointer(root, "p1", `evt-${i}`, {
      runtime_kind: "claude-code",
      native_session_id: "ns-1",
      path: t,
      captured_at: new Date().toISOString(),
    });
  }
  const files = readdirSync(path.join(sourcesDir(root), "p1")).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, MAX_POINTERS_PER_SESSION, "the directory is bounded per session");
  for (let i = 0; i < 5; i += 1) {
    assert.equal(existsSync(pointerFile(root, "p1", `evt-${i}`)), false, `oldest evt-${i} is pruned`);
  }
  assert.equal(existsSync(pointerFile(root, "p1", `evt-${MAX_POINTERS_PER_SESSION + 4}`)), true, "newest survives");

  rmSync(root, { recursive: true, force: true });
});

test("source-index: drops pointers older than 7 days", async () => {
  const root = tempDir();
  const t = path.join(root, "t.jsonl");
  writeFileSync(t, "x");
  await captureSourcePointer(root, "p1", "evt-old", { runtime_kind: "claude-code", native_session_id: "ns-old", path: t, captured_at: new Date().toISOString() });
  const oldPointer = pointerFile(root, "p1", "evt-old");
  const ancient = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  utimesSync(oldPointer, ancient, ancient);

  // Capturing any new pointer triggers the prune pass, which drops the aged one.
  await captureSourcePointer(root, "p1", "evt-fresh", { runtime_kind: "claude-code", native_session_id: "ns-old", path: t, captured_at: new Date().toISOString() });
  assert.equal(existsSync(oldPointer), false, "a pointer older than 7 days is dropped");
  assert.equal(existsSync(pointerFile(root, "p1", "evt-fresh")), true);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// end-to-end: hook -> pointer -> drain -> adapter -> commit (privacy preserved)
// ---------------------------------------------------------------------------

test("source-index: hook stdin transcript_path -> pointer -> drain parses the turn and commits, with no raw text/path in any outbox", async () => {
  const root = tempDir();
  const transcriptPath = path.join(root, "claude-session.jsonl");
  writeFileSync(
    transcriptPath,
    [
      `${JSON.stringify({ parentUuid: null, type: "user", uuid: "u1", message: { content: [{ type: "text", text: TURN_TEXT }] } })}`,
      `${JSON.stringify({ parentUuid: "u1", type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "Noted, I will remember that." }] } })}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  const binding = await resolveBinding(key, undefined, { root });

  const writer = await startWriter(root);
  const event = { key, event_ref: REF_SRC, kind: "turn_completed", internal_job_uid: null };
  // The assets-mode hook re-emits the host's transcript location as `source_path`.
  const emitted = await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: "p1",
    command: "runtime_event",
    payload: { event, source_path: transcriptPath },
  });
  assert.equal(emitted.ok, true, "the runtime event is accepted");

  // The pointer exists, is private, and holds a location only.
  const pointer = pointerFile(root, "p1", REF_SRC);
  assert.equal(statSync(pointer).mode & 0o777, 0o600);
  const pointerContent = readFileSync(pointer, "utf8");
  assert.ok(pointerContent.includes(transcriptPath));
  assert.ok(!pointerContent.includes("water the plants"), "no conversation text in the pointer");

  // The REAL claude-code adapter with the REAL readSource seam (readSourceRefs) and a
  // fake invoke — the model call is what we stub, never the source resolution.
  const invoked = [];
  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs) => readSourceRefs(root, refs),
    invoke: async (runtime, args, input, jobUid) => {
      invoked.push({ runtime, args, input, jobUid });
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            kind: "relationship",
            trait: "promise",
            content: "always keeps a promise to water the plants",
            applicability: "gardening",
            tags: ["care"],
            evidence: "explicit_user_statement",
            verification: "unverified",
            sensitivity: "normal",
          },
        ]),
        stderr: "",
      };
    },
    emit: async () => {},
  });

  const drained = await drainPendingExtractions(root, { "claude-code": adapter });
  assert.equal(drained.completed, 1, "the pending watermark drains and commits");
  await writer.close();

  assert.equal(invoked.length, 1, "exactly one model call for a resolved source");
  assert.ok(invoked[0].input.includes(TURN_TEXT), "the model input contains the completed turn text");

  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.assets).length, 1, "one asset commits from the parsed turn");
  for (const op of Object.values(snap.outbox)) {
    const raw = JSON.stringify(op);
    assert.ok(!raw.includes(transcriptPath), "no outbox envelope carries the transcript path");
    assert.ok(!raw.includes(TURN_TEXT), "no outbox envelope carries raw transcript text");
  }
  const asset = Object.values(snap.assets)[0];
  assert.ok(!JSON.stringify(asset).includes(transcriptPath), "committed assets never carry the transcript path");
  const wm = snap.extraction_watermarks[watermarkKey(binding, rangeForEvent(event))];
  assert.equal(wm.completed, true, "the range completes");

  rmSync(root, { recursive: true, force: true });
});

test("source-index: missing/relative/nonexistent path -> no pointer, no model call, honest source_unavailable", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  await resolveBinding(key, undefined, { root });

  const writer = await startWriter(root);
  const cases = [
    { ref: REF_REL, payload: { transcript_path: "relative.jsonl" } },
    { ref: REF_MISSING, payload: { transcript_path: path.join(root, "nope.jsonl") } },
    { ref: REF_NOFIELD, payload: {} },
  ];
  for (const c of cases) {
    const emitted = await sendWriter(root, {
      request_uid: randomUUID(),
      profile_id: "p1",
      command: "runtime_event",
      payload: {
        event: { key, event_ref: c.ref, kind: "turn_completed", internal_job_uid: null },
        ...c.payload,
      },
    });
    assert.equal(emitted.ok, true);
    assert.equal(existsSync(pointerFile(root, "p1", c.ref)), false, `${c.ref}: no pointer for an invalid/unset path`);
  }

  const invoked = [];
  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs) => readSourceRefs(root, refs),
    invoke: async () => {
      invoked.push(true);
      throw new Error("the model must never be called for an unreadable source");
    },
    emit: async () => {},
  });
  const drained = await drainPendingExtractions(root, { "claude-code": adapter });
  assert.equal(drained.failed, 3, "all three ranges fail honestly as source_unavailable");
  assert.equal(drained.completed, 0, "an unreadable source is never a clean completion");
  await writer.close();

  assert.equal(invoked.length, 0, "no model call for an unresolvable source");
  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.assets).length, 0, "no assets");
  for (const wm of Object.values(snap.extraction_watermarks)) {
    assert.equal(wm.completed, false);
    assert.equal(wm.state, "error", "an honest error, never a silent success");
    assert.equal(wm.last_error, "source_unavailable");
  }

  rmSync(root, { recursive: true, force: true });
});

test("source-index: a pruned/expired pointer resolves to \"\" and fails honestly as source_unavailable", async () => {
  const root = tempDir();
  const transcriptPath = path.join(root, "t.jsonl");
  writeFileSync(transcriptPath, `${TURN_TEXT}\n`);

  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
    d.consents["cdu:s1"] = makeConsent("cdu", "s1");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  await resolveBinding(key, undefined, { root });

  const writer = await startWriter(root);
  const event = { key, event_ref: REF_PRUNED, kind: "turn_completed", internal_job_uid: null };
  await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: "p1",
    command: "runtime_event",
    payload: { event, transcript_path: transcriptPath },
  });
  assert.equal(existsSync(pointerFile(root, "p1", REF_PRUNED)), true);

  // The pointer is pruned before the worker drains the watermark.
  rmSync(pointerFile(root, "p1", REF_PRUNED), { force: true });
  assert.equal(await readSourceRefs(root, [REF_PRUNED]), "", "a pruned pointer resolves to empty source");

  const adapter = createClaudeCodeAdapter({
    home: root,
    readSource: async (refs) => readSourceRefs(root, refs),
    invoke: async () => {
      throw new Error("the model must never be called for a pruned source");
    },
    emit: async () => {},
  });
  const drained = await drainPendingExtractions(root, { "claude-code": adapter });
  assert.equal(drained.failed, 1);
  assert.equal(drained.completed, 0, "a pruned source is never a clean completion");
  await writer.close();

  const snap = await readSnap(root, "p1");
  const wm = snap.extraction_watermarks[watermarkKey(await resolveBinding(key, undefined, { root }), rangeForEvent(event))];
  assert.equal(wm.completed, false);
  assert.equal(wm.state, "error", "a pruned source fails honestly, never a silent success");
  assert.equal(wm.last_error, "source_unavailable");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// absent capability stays honest + uninstall retains user assets
// ---------------------------------------------------------------------------

test("source-index: runtimes with no transcript location are never indexed, and probe never fabricates a path", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  await resolveBinding(key, undefined, { root });

  const writer = await startWriter(root);
  const emitted = await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: "p1",
    command: "runtime_event",
    // No transcript location of any kind: the runtime never reported one.
    payload: { event: { key, event_ref: REF_NOLOC, kind: "turn_completed", internal_job_uid: null } },
  });
  assert.equal(emitted.ok, true);
  await writer.close();

  assert.equal(existsSync(path.join(sourcesDir(root), "p1")), false, "no transcript location -> no index directory for the profile");

  // probe() reports only the observed capabilities, never a fabricated location.
  const adapters = createExtractAdapters(root, undefined, root);
  for (const kind of ["claude-code", "codex", "opencode", "hermes"]) {
    const probe = await adapters[kind].probe();
    assert.ok(!Object.keys(probe).some((k) => /path|transcript|source/i.test(k)), `${kind} probe never fabricates a transcript location`);
  }

  rmSync(root, { recursive: true, force: true });
});

test("source-index: uninstall leaves <root>/sources intact", async () => {
  const home = tempDir();
  const root = path.join(home, ".37soul");
  const transcriptPath = path.join(home, "t.jsonl");
  writeFileSync(transcriptPath, "x");

  await captureSourcePointer(root, "p1", "evt-keep", {
    runtime_kind: "claude-code",
    native_session_id: "ns-1",
    path: transcriptPath,
    captured_at: new Date().toISOString(),
  });
  assert.equal(existsSync(pointerFile(root, "p1", "evt-keep")), true);

  await uninstall({
    home,
    runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    nodePath: "/usr/local/bin/node",
    agentdScriptPath: "/opt/37soul/dist/cli.js",
    platform: "darwin",
    log: () => {},
  });

  assert.equal(existsSync(sourcesDir(root)), true, "sources is a user asset and survives uninstall");
  assert.equal(existsSync(pointerFile(root, "p1", "evt-keep")), true, "the pointer survives uninstall");

  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writer-path input validation (path traversal / non-UUID refusal) + internal
// ---------------------------------------------------------------------------

test("source-index: unsafe profile_id/event_ref are refused and create no files or directories", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  await resolveBinding(key, undefined, { root });
  const transcriptPath = path.join(root, "t.jsonl");
  writeFileSync(transcriptPath, "x");

  const writer = await startWriter(root);
  const unsafe = [
    { label: "traversal profile_id", event: { key: { ...key, profile_id: "../../escape" }, event_ref: REF_SRC, kind: "turn_completed", internal_job_uid: null } },
    { label: "traversal event_ref", event: { key, event_ref: "../escape", kind: "turn_completed", internal_job_uid: null } },
    { label: "separator event_ref", event: { key, event_ref: "a/b", kind: "turn_completed", internal_job_uid: null } },
    { label: "non-UUID event_ref", event: { key, event_ref: "not-a-uuid", kind: "turn_completed", internal_job_uid: null } },
    { label: "empty event_ref", event: { key, event_ref: "", kind: "turn_completed", internal_job_uid: null } },
  ];
  for (const c of unsafe) {
    const res = await sendWriter(root, {
      request_uid: randomUUID(),
      profile_id: "p1",
      command: "runtime_event",
      payload: { event: c.event, source_path: transcriptPath },
    });
    assert.equal(res.ok, false, `${c.label} is refused`);
    assert.equal(res.error?.code, "invalid_event", `${c.label} refuses with invalid_event`);
  }
  await writer.close();

  assert.equal(existsSync(sourcesDir(root)), false, "no sources directory is ever created for refused events");
  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.extraction_watermarks).length, 0, "a refused event schedules nothing");

  rmSync(root, { recursive: true, force: true });
});

test("source-index: an internal-job event never indexes a transcript location or schedules", async () => {
  const root = tempDir();
  await seedProfile(root, "p1", "dev-1", (d) => {
    d.souls["s1"] = makeSoul("s1");
  });
  const key = keyOf("p1", "dev-1", "claude-code", "ns-1");
  await resolveBinding(key, undefined, { root });
  const transcriptPath = path.join(root, "t.jsonl");
  writeFileSync(transcriptPath, `${TURN_TEXT}\n`);

  const writer = await startWriter(root);
  const emitted = await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: "p1",
    command: "runtime_event",
    payload: {
      event: { key, event_ref: REF_INTERNAL, kind: "turn_completed", internal_job_uid: "job-internal-1" },
      source_path: transcriptPath,
    },
  });
  assert.equal(emitted.ok, true, "the internal event is accepted and short-circuits");
  assert.equal(emitted.result?.scheduled, false, "an internal event never schedules");
  assert.equal(emitted.result?.reason, "internal");
  await writer.close();

  assert.equal(existsSync(sourcesDir(root)), false, "no sources directory for an internal event");
  const snap = await readSnap(root, "p1");
  assert.equal(Object.keys(snap.extraction_watermarks).length, 0, "an internal event writes no watermark");

  rmSync(root, { recursive: true, force: true });
});
