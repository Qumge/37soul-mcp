#!/usr/bin/env node
/**
 * 语言检测与用户可见文案：不改写运行时其余英文输出，只负责新加的
 * 「本地已可用 / 绑定到 37soul.com」两句 —— 它们是安装完成后第一屏会看到的话。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { detectLang, messages } from "../dist/i18n.js";

test("i18n: explicit SOUL37_LANG wins over the shell locale", () => {
  assert.equal(detectLang({ SOUL37_LANG: "zh_CN.UTF-8", LC_ALL: "ja_JP.UTF-8", LANG: "en_US.UTF-8" }), "zh");
});

test("i18n: LC_ALL then LANG decide when there is no explicit override", () => {
  assert.equal(detectLang({ LC_ALL: "ja_JP.UTF-8", LANG: "zh_CN.UTF-8" }), "ja");
  assert.equal(detectLang({ LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(detectLang({ LANG: "ja_JP.UTF-8" }), "ja");
});

test("i18n: unsupported or empty locales fall back to English", () => {
  assert.equal(detectLang({ LANG: "fr_FR.UTF-8" }), "en");
  assert.equal(detectLang({ LANG: "C" }), "en");
  assert.equal(detectLang({}), "en");
});

test("i18n: every language has its own ready + binding hint", () => {
  for (const lang of ["en", "zh", "ja"]) {
    const m = messages(lang);
    assert.ok(m.localReady.length > 0, `${lang} localReady must not be empty`);
    assert.match(m.bindingHint, /37soul login/, `${lang} hint must name the command`);
  }
  assert.match(messages("zh").bindingHint, /登录/);
  assert.match(messages("ja").bindingHint, /ログイン/);
  assert.match(messages("en").bindingHint, /log in/i);
});
