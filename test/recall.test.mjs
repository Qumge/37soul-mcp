#!/usr/bin/env node
/**
 * `37soul recall` 的核心：确定性、可解释、不调模型。
 * 边界（墓碑默认排除、空查询、AND 语义、排序）都在纯函数里，直接测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatRecallHit, parseTerms, recallAssets } from "../dist/assets/recall.js";

function asset(overrides = {}) {
  return {
    asset_uid: overrides.asset_uid ?? "a1",
    soul_uid: "s1",
    kind: "relationship",
    trait: "preference",
    content: "我对外沟通一律先给结论",
    applicability: "",
    tags: [],
    evidence: "explicit_user_statement",
    verification: "unverified",
    sensitivity: "normal",
    state: "active",
    revision: 1,
    supersedes_uid: null,
    pinned: false,
    source: { runtime_kind: "claude-code", occurred_at: "2026-10-30T10:00:00Z" },
    ...overrides,
  };
}

test("recall: 中文关键词命中内容", () => {
  const hits = recallAssets([asset()], { terms: parseTerms("结论") });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].matched, ["content"]);
});

test("recall: 多个词是 AND，缺一个就不命中", () => {
  assert.equal(recallAssets([asset()], { terms: parseTerms("结论 复盘") }).length, 0);
});

test("recall: 命中 applicability / tags / trait 也算（并说明命中在哪）", () => {
  const a = asset({ applicability: "客户分析", tags: ["周会"] });
  assert.deepEqual(recallAssets([a], { terms: parseTerms("客户分析") })[0].matched, ["applicability"]);
  assert.deepEqual(recallAssets([a], { terms: parseTerms("周会") })[0].matched, ["tag"]);
  assert.deepEqual(recallAssets([a], { terms: parseTerms("preference") })[0].matched, ["trait"]);
});

test("recall: 墓碑默认排除，--history 才出现", () => {
  const history = asset({ asset_uid: "old", content: "旧说法", state: "superseded" });
  assert.equal(recallAssets([history], { terms: parseTerms("旧说法") }).length, 0);
  const withHistory = recallAssets([history], { terms: parseTerms("旧说法"), includeHistory: true });
  assert.equal(withHistory.length, 1);
  assert.match(formatRecallHit(withHistory[0]), /\[superseded\]/);
});

test("recall: 排序 = 钉住优先 → active 先于 candidate → 新的在前", () => {
  const pinned = asset({ asset_uid: "p", content: "共同词 甲", pinned: true });
  const active = asset({ asset_uid: "a", content: "共同词 乙" });
  const candidate = asset({ asset_uid: "c", content: "共同词 丙", state: "candidate" });
  const hits = recallAssets([candidate, active, pinned], { terms: parseTerms("共同词") });
  assert.deepEqual(hits.map((h) => h.asset.asset_uid), ["p", "a", "c"]);
});

test("recall: 空查询列出全部（受 limit 限制），kind 过滤生效", () => {
  const rel = asset({ asset_uid: "r" });
  const exp = asset({ asset_uid: "e", kind: "experience", content: "先写测试再改" });
  assert.equal(recallAssets([rel, exp], { terms: [] }).length, 2);
  assert.equal(recallAssets([rel, exp], { terms: [], limit: 1 }).length, 1);
  assert.deepEqual(recallAssets([rel, exp], { terms: [], kind: "experience" }).map((h) => h.asset.asset_uid), ["e"]);
});

test("recall: 输出带状态、日期与来源，不含敏感字段", () => {
  const line = formatRecallHit(recallAssets([asset({ pinned: true })], { terms: parseTerms("结论") })[0]);
  assert.match(line, /📌/);
  assert.match(line, /2026-10-30/);
  assert.match(line, /claude-code/);
  assert.doesNotMatch(line, /asset_uid|content_digest/);
});
