#!/usr/bin/env node
/**
 * Native extraction output is not a bare array in real CLI use:
 * Claude Code wraps it in `type=result` (with `result`/`structured_output`), and
 * Codex streams JSONL. A CLI success envelope must never masquerade as 0 proposals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseExtractionOutput } from "../dist/adapters/claude-code.js";

const request = {
  job_uid: "job-1",
  runtime_kind: "claude-code",
  native_session_id: "native-session-1",
  source_event_refs: ["source-ref"],
  binding_uid: "binding-1",
  binding_revision: 1,
  soul_uid: "soul-1",
  internal_task: true,
};

const proposal = {
  kind: "relationship",
  trait: "preference",
  content: "给客户方案先列真实付费证据，再谈渠道",
  applicability: "客户方案",
  tags: ["客户", "证据"],
  evidence: "explicit_user_statement",
  verification: "confirmed",
  sensitivity: "normal",
};

test("claude result envelope: structured_output is parsed", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ignored because structured output is authoritative",
    structured_output: { proposals: [proposal] },
  });
  const parsed = parseExtractionOutput(stdout, request, ["turn-1"]);
  assert.ok("proposals" in parsed);
  assert.equal(parsed.proposals.length, 1);
  assert.equal(parsed.proposals[0].content, proposal.content);
  assert.equal(parsed.proposals[0].source.event_ref, "turn-1");
});

test("claude result envelope: result containing JSON is parsed", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ proposals: [proposal] }),
  });
  const parsed = parseExtractionOutput(stdout, request, ["turn-1"]);
  assert.equal(parsed.proposals.length, 1);
});

test("real DSML tool text is an explicit failure, never an empty extraction", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="Read">\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
  });
  const parsed = parseExtractionOutput(stdout, request, ["turn-1"]);
  assert.deepEqual(parsed, { error: { code: "tool_use_instead_of_output", retryable: false } });
});

test("a successful CLI envelope with non-JSON text is unstructured, not zero proposals", () => {
  const parsed = parseExtractionOutput(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "OK",
  }), request, ["turn-1"]);
  assert.deepEqual(parsed, { error: { code: "unstructured_output", retryable: false } });
});

test("an explicit empty proposals array is still a valid zero-asset result", () => {
  const parsed = parseExtractionOutput(JSON.stringify({
    type: "result", subtype: "success", is_error: false, structured_output: { proposals: [] },
  }), request, ["turn-1"]);
  assert.deepEqual(parsed, { proposals: [] });
});

test("codex exec JSONL: the final agent_message carries the proposals", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ proposals: [proposal] }) } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  const parsed = parseExtractionOutput(stdout, { ...request, runtime_kind: "codex" }, ["turn-1"]);
  assert.equal(parsed.proposals.length, 1);
});

test("opencode JSONL: the final text event carries the proposals", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "ses_1" }),
    JSON.stringify({ type: "text", part: { type: "text", text: JSON.stringify({ proposals: [proposal] }) } }),
  ].join("\n");
  const parsed = parseExtractionOutput(stdout, { ...request, runtime_kind: "opencode" }, ["turn-1"]);
  assert.equal(parsed.proposals.length, 1);
});

test("a failed CLI result reports model_error", () => {
  const parsed = parseExtractionOutput(JSON.stringify({
    type: "result", subtype: "error", is_error: true, result: "provider failed",
  }), request, ["turn-1"]);
  assert.deepEqual(parsed, { error: { code: "model_error", retryable: true } });
});

import { completedTurnSourceRefs, latestCompletedTurnSourceRefs, renderSourceTurn, createClaudeCodeAdapter, buildExtractionInvocation } from "../dist/adapters/claude-code.js";
import { codexCompletedTurnRefs, latestCodexCompletedTurnRefs } from "../dist/adapters/codex.js";

test("claude transcript: SessionStart attachments before the first prompt are transparent", () => {
  const jsonl = [
    JSON.stringify({ type: "attachment", uuid: "a0", parentUuid: null, attachment: { type: "hook_success" } }),
    JSON.stringify({ type: "attachment", uuid: "a1", parentUuid: "a0", attachment: { type: "environment" } }),
    JSON.stringify({ type: "user", uuid: "u1", parentUuid: "a1", message: { role: "user", content: "remember this preference" } }),
    JSON.stringify({ type: "attachment", uuid: "a2", parentUuid: "u1", attachment: { type: "model" } }),
    JSON.stringify({ type: "assistant", uuid: "m1", parentUuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "noted" }] } }),
    JSON.stringify({ type: "user", uuid: "u2", parentUuid: "m1", message: { role: "user", content: "next turn" } }),
  ].join("\n");
  assert.deepEqual(completedTurnSourceRefs(jsonl), ["u1", "m1"]);
  assert.match(renderSourceTurn(jsonl, completedTurnSourceRefs(jsonl)), /remember this preference/);
  assert.match(renderSourceTurn(jsonl, completedTurnSourceRefs(jsonl)), /noted/);
  assert.doesNotMatch(renderSourceTurn(jsonl, completedTurnSourceRefs(jsonl)), /next turn/);
});

test("codex rollout: latest turn refs replace the first turn refs", () => {
  const jsonl = [
    JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: "s1" } }),
    JSON.stringify({ ordinal: 1, type: "turn_context", payload: {} }),
    JSON.stringify({ ordinal: 2, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] } }),
    JSON.stringify({ ordinal: 3, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "first noted" }] } }),
    JSON.stringify({ ordinal: 4, type: "turn_context", payload: {} }),
    JSON.stringify({ ordinal: 5, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] } }),
    JSON.stringify({ ordinal: 6, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "second noted" }] } }),
  ].join("\n");
  assert.deepEqual(codexCompletedTurnRefs(jsonl).refs, ["2", "3"]);
  assert.deepEqual(latestCodexCompletedTurnRefs(jsonl).refs, ["5", "6"]);
});

test("codex rollout: developer/setup response items before turn_context are ignored", () => {
  const jsonl = [
    JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: "s1" } }),
    JSON.stringify({ ordinal: 1, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "setup" }] } }),
    JSON.stringify({ ordinal: 2, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>" }] } }),
    JSON.stringify({ ordinal: 3, type: "turn_context", payload: { cwd: "/tmp" } }),
    JSON.stringify({ ordinal: 4, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "remember this" }] } }),
    JSON.stringify({ ordinal: 5, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "noted" }] } }),
  ].join("\n");
  assert.deepEqual(codexCompletedTurnRefs(jsonl).refs, ["4", "5"]);
});


test("two Claude turns: source_turn_refs select the completed turn, not always the first", async () => {
  const jsonl = [
    JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "first preference" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "first noted" }] } }),
    JSON.stringify({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "second preference" } }),
    JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "second noted" }] } }),
  ].join("\n");
  assert.deepEqual(completedTurnSourceRefs(jsonl), ["u1", "a1"]);
  assert.deepEqual(latestCompletedTurnSourceRefs(jsonl), ["u2", "a2"]);
  let modelInput = "";
  const adapter = createClaudeCodeAdapter({
    home: "/tmp/probe",
    readSource: async () => jsonl,
    invoke: async (_runtime, _args, input) => {
      modelInput = input;
      return { code: 0, stdout: JSON.stringify({ proposals: [] }), stderr: "" };
    },
    emit: async () => {},
  });
  await adapter.extract({ ...request, source_event_refs: ["pointer"], source_turn_refs: ["u2", "a2"] });
  assert.match(modelInput, /second preference/);
  assert.doesNotMatch(modelInput, /first preference/);
  assert.match(modelInput, /User: second preference/);
  assert.match(modelInput, /Assistant: second noted/);
});

test("extraction prompt separates stable relationship preferences from one-off instructions", () => {
  const { input } = buildExtractionInvocation(request, "User: stable preference\nAssistant: noted");
  assert.match(input, /kind "relationship", trait "preference"/);
  assert.match(input, /one-off task instructions/);
  assert.match(input, /do not call tools/);
  assert.match(input, /Assistant suggestions are context/);
});
