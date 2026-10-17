#!/usr/bin/env node
/**
 * 解析器契约测试：用真机观测到的形状写成的合成 fixture，钉死归一化输出。
 * fixture 里**没有**任何真实会话内容。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createClaudeCodeParser } from "../dist/agentd/parsers/claude-code.js";
import { createCodexParser } from "../dist/agentd/parsers/codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function records(name) {
  return readFileSync(path.join(here, "fixtures", "transcripts", name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function runParser(parser, list) {
  const events = [];
  for (const record of list) events.push(...parser.push(record));
  return events;
}

test("claude-code: normalizes human input, assistant text and paired tools, skipping metadata/sidechains", () => {
  const parser = createClaudeCodeParser({ externalId: "fallback-name" });
  const before = runParser(parser, records("claude-code.jsonl"));
  const afterFlush = parser.flush();

  const userTexts = before.filter((e) => e.role === "user").map((e) => e.text);
  const assistantTexts = before.filter((e) => e.role === "assistant").map((e) => e.text);
  const tools = before.filter((e) => e.role === "tool");

  assert.deepEqual(userTexts, ["给 /users 接口加分页", "默认 page size 用 20"]);
  assert.deepEqual(assistantTexts, ["先看现在的实现", "给查询层加上 limit/offset", "好，默认 20，下一步把分页元数据带上。"]);

  assert.deepEqual(
    tools.map((e) => [e.tool.name, e.tool.input_summary, e.tool.is_error]),
    [
      ["Read", "app/controllers/users_controller.rb", false],
      ["Edit", "app/controllers/users_controller.rb", false],
      ["Bash", "bundle exec rspec spec/requests/users_spec.rb", false],
      ["Bash", "npm run typecheck", true],
    ],
  );
  assert.equal(tools[0].tool.output_summary.includes("class UsersController"), true);
  assert.equal(tools[3].tool.output_summary, "error TS2307: Cannot find module './pagination'");

  // 子代理、注入记录（isMeta）、metadata 一律不出现。
  assert.ok(before.every((e) => !String(e.text ?? "").includes("内部子代理")));
  assert.ok(before.every((e) => !String(e.text ?? "").includes("/clear")));
  assert.deepEqual(afterFlush, [], "调用都配对了结果，flush 不该再吐东西");

  const meta = parser.metadata();
  assert.equal(meta.external_id, "aaaaaaaa-1111-2222-3333-444444444444"); // sessionId 优先于文件名字回退
  assert.equal(meta.cwd, "/Users/dev/nimbus");
  assert.equal(meta.branch, "feature/pagination");
  assert.equal(meta.started_at, "2026-10-17T02:00:01.000Z");
  assert.equal(parser.ended(), false);
});

test("claude-code: a call without a result is flushed as an unanswered tool event", () => {
  const parser = createClaudeCodeParser();
  parser.push({
    type: "assistant",
    timestamp: "2026-10-17T02:10:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "sleep 999" } }] },
  });

  const flushed = parser.flush();

  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0].tool, { name: "Bash", input_summary: "sleep 999", output_summary: "", is_error: false });
});

test("claude-code: Unicode survives normalization", () => {
  const parser = createClaudeCodeParser();
  const [event] = parser.push({
    type: "user",
    timestamp: "2026-10-17T02:11:00.000Z",
    origin: { kind: "human" },
    message: { role: "user", content: "我家狗叫 Mochi 🐕，它刚做完手术。" },
  });

  assert.equal(event.text, "我家狗叫 Mochi 🐕，它刚做完手术。");
});

test("codex: normalizes user/assistant messages and pairs custom/function tool calls with outputs", () => {
  const parser = createCodexParser({ externalId: "fallback" });
  const events = runParser(parser, records("codex.jsonl"));
  const tools = events.filter((e) => e.role === "tool");

  assert.deepEqual(events.filter((e) => e.role === "user").map((e) => e.text), ["给 /users 接口加分页"]);
  assert.deepEqual(
    events.filter((e) => e.role === "assistant").map((e) => e.text),
    ["先看现在的接口实现", "分页参数好了；测试挂了，先看一眼。"],
  );

  assert.deepEqual(
    tools.map((e) => [e.tool.name, e.tool.input_summary, e.tool.is_error]),
    [
      ["exec", "sed -n '1,40p' app/controllers/users_controller.rb", false],
      ["apply_patch", "app/controllers/users_controller.rb", false],
      ["exec", "bundle exec rspec spec/requests/users_spec.rb", true],
    ],
  );
  assert.ok(tools[0].tool.output_summary.includes("Script completed"));
  assert.ok(tools[2].tool.output_summary.includes("Script failed"));
  assert.ok(events.every((e) => !String(e.text ?? "").includes("<environment_context>")));

  const meta = parser.metadata();
  assert.equal(meta.external_id, "01a13000-0000-7000-8000-000000000001");
  assert.equal(meta.cwd, "/Users/dev/nimbus");
  assert.equal(meta.started_at, "2026-10-17T03:00:00.000Z");
  assert.equal(parser.ended(), false);
});

test("codex: a pending call is flushed with its observed status when no output arrives", () => {
  const parser = createCodexParser();
  parser.push({
    timestamp: "2026-10-17T03:10:00.000Z",
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "call_z", name: "exec", status: "failed", input: 'tools.exec_command({cmd:"ls"});' },
  });

  const [flushed] = parser.flush();

  assert.equal(flushed.tool.name, "exec");
  assert.equal(flushed.tool.input_summary, "ls");
  assert.equal(flushed.tool.is_error, true);
});
