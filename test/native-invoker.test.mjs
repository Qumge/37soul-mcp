#!/usr/bin/env node
/**
 * Task 10 (ledger GAP): the runtime adapters plus the spawn-based
 * `NativeInvoker` are wired into agentd's assets-mode drain. Until now
 * `extractAdapters` defaulted to `{}` inside `createDaemon`, so no extraction
 * ever ran in production.
 *
 * These tests pin the honest contract:
 *  - `createExtractAdapters(home)` returns all registered `RuntimeAdapter`s on one
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

const ALL_KINDS = ["claude-code", "codex", "opencode", "hermes", "pi", "gemini-cli", "cursor"];

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
  assert.equal(calls[0].options.timeout, 120_000, "codex may spend longer than claude-code on a cold model start, but stays bounded");
  assert.equal(calls[0].options.env.SOUL37_INTERNAL_JOB_UID, "job-123", "internal job uid rides in the env so the hook can tag its session");
});

test("native-invoker: the timeout is per runtime — claude-code keeps the 60s bound", async () => {
  const { calls, spawn } = recordingSpawn();
  const invoke = createNativeInvoker(undefined, spawn);

  await invoke("claude-code", ["-p"], "prompt", "job-1");

  assert.equal(calls[0].options.timeout, 60_000);
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

test("native-invoker: an unregistered runtime fails cleanly without spawning", async () => {
  const { calls, spawn } = recordingSpawn();
  const invoke = createNativeInvoker(undefined, spawn);

  const result = await invoke("unknown-runtime", [], "", "job-x");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no native binary/i);
  assert.equal(calls.length, 0, "must not spawn an undefined command");
});

test("extract-adapters: all registered runtimes are wired, and extract short-circuits honestly on an empty source", async () => {
  const adapters = createExtractAdapters("/tmp/37soul-adapters");
  assert.deepEqual(Object.keys(adapters).sort(), [...ALL_KINDS].sort(), "exactly the runtime adapters, no more");

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

 test("native-invoker: failure logging excludes raw child diagnostics and credential canaries", async () => {
  const logs = [];
  const invoke = createNativeInvoker({info: value => logs.push(value), error: value => logs.push(value)}, (_command, _args, _options, callback) => {
    callback(Object.assign(new Error("provider failed: SECRET_CANARY"), {code: 7}), "", "PRIVATE_STDERR_CANARY");
    return {stdin: {write() {}, end() {}}, kill() {}};
  });
  const result = await invoke("codex", ["exec"], "PRIVATE_INPUT_CANARY", "job-log");
  assert.equal(result.code, 7);
  assert.match(logs.join("\n"), /native codex exited 7/);
  assert.doesNotMatch(logs.join("\n"), /SECRET_CANARY|PRIVATE_STDERR_CANARY|PRIVATE_INPUT_CANARY/);
 });

test("native-invoker: a timeout is named in the log instead of leaving a bare exit code", async () => {
  const logs = [];
  const invoke = createNativeInvoker({info: value => logs.push(value), error: value => logs.push(value)}, (_command, _args, _options, callback) => {
    // Same shape execFile reports when its `timeout` fires: killed by SIGTERM, no exit code.
    callback(Object.assign(new Error("Command failed"), {code: null, killed: true, signal: "SIGTERM"}), "", "PRIVATE_STDERR_CANARY");
    return {stdin: {write() {}, end() {}}, kill() {}};
  });
  const result = await invoke("codex", ["exec"], "", "job-timeout");
  assert.equal(result.code, 1);
  assert.match(logs.join("\n"), /native codex exited 1 \(timeout after 120000ms\)/);
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_STDERR_CANARY/);
});

test("native-invoker: failure classes come from a fixed allowlist, never raw stderr", async () => {
  const classes = [
    ["429 Too Many Requests: rate limit exceeded", "rate_limited", "HTTP 429 Too Many Requests"],
    ["Error: not logged in. Run codex login", "auth", "not logged in"],
    ["stream error: ECONNRESET socket hang up", "network", "ECONNRESET"],
    ["error: unexpected argument '--nope' found", "usage", "unexpected argument"],
    ["something entirely private: PRIVATE_STDERR_CANARY", "other", null],
  ];
  for (const [stderr, expected, rawFragment] of classes) {
    const logs = [];
    const invoke = createNativeInvoker({info: value => logs.push(value), error: value => logs.push(value)}, (_command, _args, _options, callback) => {
      callback(Object.assign(new Error("Command failed"), {code: 1}), "", stderr);
      return {stdin: {write() {}, end() {}}, kill() {}};
    });
    await invoke("codex", ["exec"], "", "job-class");
    const line = logs.join("\n");
    assert.match(line, new RegExp(`native codex exited 1 \\(stderr ${expected}, \\d+ bytes\\)`), stderr);
    if (rawFragment !== null) assert.ok(!line.includes(rawFragment), `raw stderr must not be logged: ${rawFragment}`);
  }
});
