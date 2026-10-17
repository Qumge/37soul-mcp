#!/usr/bin/env node
/**
 * Task 7 的契约测试：
 *   1. repo_key 与服务端共用同一份 fixture（逐字节一致），归一化结果必须逐条相同；
 *   2. 上传协议的大小/连续性约束（≤200 条、≤512KB、seq 连续）；
 *   3. 原生 fixture 的形状：Claude Code / Codex 的 JSONL 每条都是完整对象，
 *      且包含解析器必须处理/必须排除的所有记录类型（Task 8 的解析器契约）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { repoKey, normalizeRemote, pathRepoKey } from "../dist/repo-key.js";
import { batchEvents, validateBatch, ProtocolError, LIMITS, utf8Bytes } from "../dist/agentd/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (p) => path.join(here, "fixtures", p);

const repoFixture = JSON.parse(readFileSync(fixture("repo_keys.json"), "utf8"));

test("repo-key: every shared remote fixture case normalizes identically to the server", () => {
  for (const testCase of repoFixture.remote_cases) {
    assert.equal(normalizeRemote(testCase.remote), testCase.expected, `remote ${JSON.stringify(testCase.remote)}`);
  }
});

test("repo-key: path fallback requires a machine id and an absolute cwd, like the server", () => {
  for (const testCase of repoFixture.path_cases) {
    const actual = repoKey({
      remote: testCase.remote,
      machineId: testCase.machine_id,
      cwd: testCase.cwd,
    });
    assert.equal(actual, testCase.expected, `case ${JSON.stringify(testCase)}`);
  }
});

test("repo-key: two machines never share one path-keyed workspace", () => {
  const a = pathRepoKey("machine-a", "/srv/app");
  const b = pathRepoKey("machine-b", "/srv/app");
  assert.notEqual(a, b);
});

test("repo-key: the remote wins when both remote and cwd are present", () => {
  assert.equal(repoKey({ remote: "git@github.com:owner/repo.git", machineId: "m1", cwd: "/Users/x/repo" }), "github.com/owner/repo");
});

function event(seq, overrides = {}) {
  return {
    seq,
    at: new Date(Date.UTC(2026, 9, 17, 3, 0, seq)).toISOString(),
    role: "user",
    text: `event ${seq}`,
    ...overrides,
  };
}

test("protocol: batches stay within 200 events and 512KB", () => {
  const events = Array.from({ length: 450 }, (_, i) => event(i + 1));
  const buildPayload = (batch, seqFrom, seqTo) => ({ machine_id: "m", seq_from: seqFrom, seq_to: seqTo, events: batch, padding: "x".repeat(0) });
  const batches = batchEvents(events, buildPayload);

  assert.deepEqual(batches.map((b) => b.events.length), [200, 200, 50]);
  assert.deepEqual(batches.map((b) => [b.seqFrom, b.seqTo]), [[1, 200], [201, 400], [401, 450]]);
  assert.equal(batches.flatMap((b) => b.events).length, 450);
});

test("protocol: bytes are split too, without splitting a single event", () => {
  const big = "x".repeat(5000);
  const events = Array.from({ length: 300 }, (_, i) => event(i + 1, { text: `${i}:${big}` }));
  const buildPayload = (batch, seqFrom, seqTo) => ({ seq_from: seqFrom, seq_to: seqTo, events: batch });
  const batches = batchEvents(events, buildPayload);

  assert.ok(batches.length > 1);
  for (const batch of batches) {
    assert.ok(batch.events.length <= LIMITS.maxEventsPerBatch);
    assert.ok(utf8Bytes(JSON.stringify(buildPayload(batch.events, batch.seqFrom, batch.seqTo))) <= LIMITS.maxBatchBytes);
  }
  assert.equal(batches.flatMap((b) => b.events).length, 300);
});

test("protocol: a single event bigger than the batch limit still gets its own batch", () => {
  const events = [event(1, { text: "y".repeat(8000) })];
  const batches = batchEvents(events, (batch) => ({ events: batch }));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].events.length, 1);
});

test("protocol: validation accepts a contiguous well-formed batch", () => {
  const events = [
    event(1, { role: "user", text: "hello" }),
    event(2, { role: "assistant", text: "hi" }),
    event(3, { role: "tool", text: "", tool: { name: "Read", input_summary: "a.rb", output_summary: "ok", is_error: false } }),
    event(4, { role: undefined, text: undefined, event_type: "session_end" }),
  ];
  assert.doesNotThrow(() => validateBatch(events));
});

test("protocol: validation rejects gaps, bad roles, oversized text and malformed tools", () => {
  assert.throws(() => validateBatch([event(1), event(3)]), ProtocolError);
  assert.throws(() => validateBatch([event(1, { role: "system" })]), ProtocolError);
  assert.throws(() => validateBatch([event(1, { text: "z".repeat(8001) })]), ProtocolError);
  assert.throws(() => validateBatch([event(1, { role: "tool", tool: undefined })]), ProtocolError);
  assert.throws(() => validateBatch([event(1, { at: "yesterday" })]), ProtocolError);
});

function readJsonl(file) {
  const text = readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"), "fixture must end with a newline so no line is partial");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`${file}:${index + 1} is not a complete JSON object: ${e.message}`);
      }
    });
}

test("claude-code fixture: complete JSONL objects with the record types the parser must handle and exclude", () => {
  const records = readJsonl(fixture("transcripts/claude-code.jsonl"));
  const types = new Set(records.map((r) => r.type));

  for (const required of ["user", "assistant", "system"]) {
    assert.ok(types.has(required), `fixture should cover ${required}`);
  }
  // attachment 记录没有顶层 type（实测），用它的 attachment 字段识别。
  assert.ok(records.some((r) => r.attachment), "fixture should cover attachment records");
  assert.ok(types.has("last-prompt") && types.has("mode"), "metadata records must be present to prove they are skipped");

  const human = records.find((r) => r.type === "user" && typeof r.message?.content === "string" && !r.isMeta);
  assert.ok(human?.origin?.kind === "human");

  const toolResult = records.find(
    (r) => r.type === "user" && Array.isArray(r.message?.content) && r.message.content.some((b) => b.type === "tool_result"),
  );
  assert.ok(toolResult?.toolUseResult !== undefined, "tool results come with a top-level toolUseResult");

  const toolUse = records.find(
    (r) => r.type === "assistant" && r.message?.content?.some((b) => b.type === "tool_use"),
  );
  assert.ok(toolUse?.message.content.some((b) => b.type === "tool_use" && typeof b.id === "string"));

  assert.ok(records.some((r) => r.isSidechain === true), "a sidechain record must be present and excluded");
  assert.ok(records.some((r) => r.isMeta === true), "a meta record must be present and excluded");
  assert.ok(records.some((r) => r.gitBranch === "feature/pagination"), "the fixture carries a branch");
});

test("codex fixture: complete JSONL objects with session meta, messages, tool calls and outputs", () => {
  const records = readJsonl(fixture("transcripts/codex.jsonl"));
  const payloadTypes = new Set(records.map((r) => r.payload?.type).filter(Boolean));

  assert.ok(records.some((r) => r.type === "session_meta" && r.payload?.id));
  assert.ok(records.some((r) => r.type === "turn_context" && r.payload?.cwd));
  assert.ok(payloadTypes.has("message"));
  assert.ok(payloadTypes.has("custom_tool_call") && payloadTypes.has("custom_tool_call_output"));
  assert.ok(payloadTypes.has("function_call") && payloadTypes.has("function_call_output"));

  const callIds = new Set(records.filter((r) => r.payload?.call_id).map((r) => r.payload.call_id));
  assert.ok(callIds.size >= 3);

  const failed = records.find((r) => r.payload?.type === "custom_tool_call_output" && String(r.payload.output).includes("Script failed"));
  assert.ok(failed, "a failing tool output must be present so is_error can be pinned");

  assert.ok(records.some((r) => r.payload?.type === "reasoning"), "reasoning records must be present and excluded");
  assert.ok(records.some((r) => String(r.payload?.content?.[0]?.text ?? "").includes("<environment_context>")), "environment context must be present and excluded");
});
