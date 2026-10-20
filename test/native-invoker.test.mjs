#!/usr/bin/env node
/**
 * Task 10 (ledger GAP): the four runtime adapters plus the spawn-based
 * `NativeInvoker` are wired into agentd's assets-mode drain. Until now
 * `extractAdapters` defaulted to `{}` inside `createDaemon`, so no extraction
 * ever ran in production.
 *
 * These tests pin the honest contract:
 *  - `createExtractAdapters(home)` returns all four `RuntimeAdapter`s on one
 *    shared `AdapterDeps`.
 *  - `readSource` resolves the opaque event refs through the local path-pointer
 *    index (Task 10c; see source-index.test.mjs for the index itself). With no
 *    pointer on disk it returns "" and every adapter `extract` short-circuits to
 *    `{ error: { code: "source_unavailable", retryable: true } }` before any
 *    model call.
 *  - `createNativeInvoker` maps the runtime kind to the one place the concrete
 *    binary spelling lives, tags the internal job uid via
 *    `SOUL37_INTERNAL_JOB_UID`, pipes input on stdin and never hangs on a
 *    failed/killed spawn.
 *
 * No real process is spawned: `createNativeInvoker` takes an injectable spawn.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createNativeInvoker, createExtractAdapters } from "../dist/agentd/native-invoker.js";

const ALL_KINDS = ["claude-code", "codex", "opencode", "hermes"];

/** A fake spawn that records every call and synchronously invokes its callback. */
function recordingSpawn(responder = () => ({ stdout: "[]", stderr: "" })) {
  const calls = [];
  const spawn = (command, args, options, callback) => {
    calls.push({ command, args: [...args], options });
    const { stdout, stderr } = responder(command, args);
    callback(null, stdout, stderr);
    return { stdin: { write() {}, end() {} }, kill() {} };
  };
  return { calls, spawn };
}

test("native-invoker: maps runtime kind to the concrete CLI binary and tags the job uid via env", async () => {
  const { calls, spawn } = recordingSpawn();
  const invoke = createNativeInvoker(undefined, spawn);

  const result = await invoke("codex", ["exec", "--output-format", "json"], "prompt text", "job-123");

  assert.deepEqual(result, { code: 0, stdout: "[]", stderr: "" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "codex", "the only place the binary spelling lives");
  assert.deepEqual(calls[0].args, ["exec", "--output-format", "json"]);
  assert.equal(calls[0].options.timeout, 60_000, "spawn is bounded, never hangs the drain");
  assert.equal(calls[0].options.env.SOUL37_INTERNAL_JOB_UID, "job-123", "internal job uid rides in the env so the hook can tag its session");
});

test("native-invoker: a failed spawn resolves with a non-zero code instead of rejecting/hanging", async () => {
  // Simulate execFile's error-first callback path (no stdout/stderr on failure).
  const invoke = createNativeInvoker(undefined, (_command, _args, _options, callback) => {
    callback(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "", "");
    return { stdin: { write() {}, end() {} }, kill() {} };
  });

  const result = await invoke("hermes", ["--version"], "", "job-9");
  assert.deepEqual(result, { code: 1, stdout: "", stderr: "" });
});

test("native-invoker: a spawn without a stdin pipe is killed, never left running", async () => {
  let killed = false;
  const invoke = createNativeInvoker(undefined, (_command, _args, _options, callback) => {
    callback(null, "", "");
    return { stdin: null, kill: () => { killed = true; } };
  });

  const result = await invoke("opencode", ["run"], "input", "job-7");
  assert.equal(result.code, 0);
  assert.equal(killed, true, "no stdin pipe means the process must be killed");
});

test("extract-adapters: all four runtimes are wired, and extract short-circuits honestly on an empty source", async () => {
  const adapters = createExtractAdapters("/tmp/37soul-adapters");
  assert.deepEqual(Object.keys(adapters).sort(), [...ALL_KINDS].sort(), "exactly the four runtime adapters, no more");

  for (const kind of ALL_KINDS) {
    const adapter = adapters[kind];
    assert.equal(adapter.runtime_kind, kind);

    const extraction = await adapter.extract({
      job_uid: "job-1",
      runtime_kind: kind,
      native_session_id: "native-session-1",
      source_event_refs: ["opaque-random-ref-1"],
      binding_uid: "binding-1",
      binding_revision: 1,
      soul_uid: "soul-1",
      internal_task: true,
    });

    // readSource resolves refs through the local pointer index; with nothing on
    // disk it returns "", so every adapter short-circuits to an honest
    // source_unavailable error before any model call — never a silent empty
    // proposal set. (Pointer resolution itself is covered in source-index.test.mjs.)
    assert.deepEqual(
      extraction,
      { error: { code: "source_unavailable", retryable: true } },
      `${kind} must not fabricate source or invoke the model`,
    );
  }
});
