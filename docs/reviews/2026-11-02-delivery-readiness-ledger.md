# Delivery readiness ledger

> 本页保留阶段验收过程；最终上线状态、测试及产物证据见 [v0.14.0 交付记录](2026-11-02-v0.14.0-release.md)。

## 当前结论（2026-11-02，替代下方历史结论）

以下按 parent 本轮同步的状态记录；尚在执行或待执行的检查不计为通过。本文后面的旧状态、阻塞原因、预算和发布门槛均保留为历史，不能覆盖本节。

| 宿主 | 完整原生闭环及网站修正后全新会话采用 | 累计 native/model 入口（含自动提取） |
| --- | --- | ---: |
| Claude Code 2.1.316 | PASS | 5 |
| Codex 0.166.0 | PASS | 6 |
| Pi 1.4.0 | PASS | 5 |
| Hermes 0.21.0 | PASS；实际网页修正 Juniper → Willow → Cedar，旧资产排除 | 历史 6 + 新明确授权 4 = 10 |
| OpenCode 2.0.32 | PASS；现有 DeepSeek 授权，实际网页修正 Dawn → Noon → Dusk，旧资产排除 | 历史 2 + 新授权 4 = 6 |

- 五宿主原生功能验收已完成；旧 Hermes 修正缺口与 OpenCode 提供方阻塞已被补验替代。入口数包括自动提取，不等于提供方账单请求数；没有购买额度或追加未授权调用。详见 [Hermes 最终验收与清理](2026-11-02-final-hermes-continuation.md) 和 [OpenCode 记录](2026-11-02-opencode-delivery.md)。
- 清理已完成：本轮 synthetic owner 1 及 exact manifest 资源 fresh counts 全 0，fixture/owned HOME/provider 副本与两个 stale pointers 已移除，Puma 75303 已停止，8087 connection refused。此前 owner 2 的清理是另一历史轮次。无 drop/flush，无真实 auth/生产数据清理；parent-owned TaskSpace60 未由本 worker 关闭。
- 三语言根 README 已在 `d712641` 提升为公开候选说明；候选分支已 push，main 未合并，未发布 release、未部署。候选分支上的公开说明不等于正式 curl 分发已更新。
- macOS 显式重装 re-enable 修复 `da65089`：先 2 RED 后 2 GREEN；service focused `84/84 PASS`。这是修复与 focused 证据，不能替代新远程 macOS 执行结果。
- parent 同步的未准备 pack artifacts 全量检查点为 `596 tests / 595 pass / 0 fail / 1 skip`。parent 接下来先 pack 再跑全量，要求 `0 skip`；本快照未取得该后续完成结果，不将其标为 PASS。
- 远程 [41400808980](https://github.com/Qumge/37soul-mcp/actions/runs/41400808980) 正在跑（parent 本轮同步：Node 18/20/24 + macOS/Linux），结果待核对。旧 [41399296693](https://github.com/Qumge/37soul-mcp/actions/runs/41399296693) 的 Node 全绿、Linux 真实服务 PASS；macOS 因重装时 disabled 状态失败，已有 `da65089` 修复，等待新远程验证，不回写旧 run 为成功。
- 网站 Singer 工作继续，由 parent 跟进。五宿主功能 PASS 不代替网站其余工作、pack 后零 skip 全测、远程 OS 验收、main 合并或正式发布/部署。

本 ledger 的当前发布边界：五宿主功能 PASS，候选已 push；pack 后全测与新远程 CI 待完成，正式发布/部署未执行。

## 历史记录（以下原文保留，旧结论已被顶部替代）

Baseline runtime/source/remote main: 632f60695d4d65583d17c45db663a1c8eabef672. Public latest: v0.13.4, published 2026-11-01T09:02:14Z. Website baseline: 8baeeab1. All checks below must distinguish source analysis, fake harness, native execution, local Rails and production.

## Rulings
- No raw transcript backward compatibility is required. Retire complete raw egress paths; preserve local source readers and user data.
- legacy_host_id is a current website mapping, not a removable obsolete feature. Renaming it is not needed to eliminate old protocols.
- Found historical four-host adoption evidence at website tmp/reviews/2026-10-21-qoder-source-repair/root-0117-live/acceptance.md. This used local Rails, isolated configuration and foreground agentd; it is neither absent nor equivalent to current default-install acceptance. Pi was not included.
- Shared runtime worktree has parallel edits only on disjoint source domains: raw egress, issuer credentials, Pi adapter. Full build/test integration is serialized by parent after these finish.
- Website ban fix is isolated in .worktrees/delivery-account-auth; removed_at recovery policy remains unchanged.
- Probe scripts currently omit Pi in live all and use explicit native configuration shortcuts; do not use their aggregate pass as delivery completion.
- Existing README 383-test count is stale, and 'five extraction smoke' conflicts with Pi unsupported. Do not replace these with invented success; public rewrite waits for implementation/acceptance.

## Observed host versions (read-only CLI)
- Claude Code 2.1.316
- Codex 0.166.0
- OpenCode 2.0.32
- Hermes 0.21.0
- Pi 1.4.0
These are observed installed versions, not all verified delivery support.

## Status
- Baseline TypeScript build: passed.
- Task 1 runtime: implemented and locally committed in dea4aa2; raw egress regression probes passed. Website legacy endpoint retirement is being finalized.
- Task 2 runtime: issuer-bound credentials, owner/device guards and active-profile handling implemented in dea4aa2.
- Task 2 website: locally committed and integrated; final named integration tests 407/407 at 8abe8508, independent review passed.
- Task 3 Pi: implemented; real managed foreground loop passed. Background executable/PATH reliability is receiving additional failing regressions before its fix.
- Task 4: bounded acceptance ended. Four native core loops passed; correction adoption passed for Pi/Claude/Codex. OpenCode quota and Hermes correction cap remain release gaps.
- Task 5: not complete; no public release/update performed.

## Task 1 worker evidence

Task 1: hook extension RED 6/6 (old runHook plus SessionStart/UserPromptSubmit/Stop/PreCompact/PostToolUse). Removed resolveBrief, remote/cache fallback, raw spool append and old reinjection/mapping helpers. Preserved assets runtime events, source-index, native context and source boundaries. No user files deleted.
Task 1: final focused GREEN 144/144, 0 failures, 0 skipped; command: node --test test/raw-egress-retirement.test.mjs test/hook.test.mjs test/agentd.test.mjs test/assets-mode.test.mjs test/source-index.test.mjs test/source-boundary.test.mjs test/extraction.test.mjs test/extraction-output.test.mjs test/native-invoker.test.mjs test/cli.test.mjs test/reader.test.mjs test/queue.test.mjs. Log: /private/tmp/37soul-delivery-raw-focused-final.log.
Task 1: npm run build PASS; npm run bundle PASS; node test/smoke.mjs PASS (64 checks); git diff --check for Task 1 files PASS. Logs /private/tmp/37soul-delivery-raw-{build-final,bundle,smoke}.log. Total newly observed RED probes 17 (9+1+1+6), all now GREEN.
Task 1: self-review only; parent owns independent review, full npm test and commit. No changes made by this worker to src/agentd/credentials.ts, src/sync/client.ts, src/install.ts, main checkout, actual HOME or production. Source writes finished; parent may run full suite now.
Task 1: residual inactive legacy brief-cache utility retains its standalone export/tests; no live daemon/hook caller remains. This worker did not expand retirement into removing unrelated cache/exclude utilities. Current account/character tools preserved; no native-host or production delivery claim.

## Integrated verification and new findings
- Production dependency audit independently refreshed after SDK/Zod upgrades: 0 vulnerabilities. Independent dependencies under /private/tmp, original main checkout dependencies unchanged.
- First integrated run: 459 tests, 454 pass, 3 fail, 2 skipped. Retired-spool assertion and missing-issuer/scoped-login fixtures were corrected without weakening privacy assertions.
- New issuer ownership and active-profile guards intentionally reject incomplete cloud metadata. Their former positive fixtures were updated to represent real login state; invalid/ambiguous/unknown issuer negatives remain denied.
- Intermediate complete run: 476 tests, 476 pass, 0 fail, 0 skip, smoke passed; real Node 18 binary and packed artifacts were required.
- Real installer/native preparation then exposed active-profile failure: install created default after non-default login, while hook accepted only a singleton. Added explicit active profile, reinstall preservation and strict metadata/device/issuer validation; no manual test-data workaround.
- Fresh independent review exposed null credential entries crashing writes, CLI default disagreeing with active hook, and device-token POST following cross-issuer 307. All three received failing regressions then fixes. Independent follow-up: 24 targeted tests passed, no remaining blocker in reviewed scope.
- Fifth integrated candidate checkpoint /private/tmp/37soul-delivery-full-fifth.log: 503 tests, 503 pass, 0 fail, 0 skipped; smoke all checks passed. Node floor 18.20.8 was fetched from nodejs.org and SHA-256 verified; pack tests were mandatory. This is not five-host native acceptance.
- Linux service activation now restarts new ExecStart after reload/enable and restores old unit on failure; first-install failure disables newly enabled service. 8 focused tests passed with injected systemctl, not real Linux execution.
- CLI sync without valid profile now fails actionably rather than returning false success; default commands follow active profile, bulk sync is explicit --all-profiles.

## Real local acceptance
- Browser sign-in -> real device code -> selecting synthetic Soul -> approval -> CLI login exit 0 -> 5 issuer-scoped credentials -> first Soul restore completed against local Rails 8087 in dedicated test DB. Final candidate login persists active browser-delivery and hook resolver matches it.
- Pi 1.4.0 managed extension -> actual Stop source -> foreground daemon/native extraction -> active local asset -> real Rails sync -> real AssetWriter correction -> pull -> fresh Pi session adopted correction without answer in human prompt. 3 new native calls, cumulative Pi 5. It does not claim a default global launchd install.
- Browser then displayed the actual synced Pi asset and successfully edited it, preserving two historical versions. Initial browser save was blocked by test Rack allowlist not recognizing canonical host slugs; test gate fixed, application code unaffected.
- Existing user runtime/host config, main branches and public v0.13.4 remain unchanged. Candidate source version is 0.14.0, not published.
- Claude Code 2.1.316 also passed managed first session -> automatic extraction -> real local cloud sync -> fresh recall -> owned cloud correction -> corrected fresh recall. Cumulative native calls 5/6, with a persistent gate counting daemon extraction. See separate Claude evidence report.
- Dedicated browser-approved revocation device: DELETE returned 204; default sync returned 1 and cleared all downloaded private assets and all five device credentials. A local-only original Soul remained usable in a real new hook context; revoked cloud Soul/content were absent. Result: /private/tmp/37soul-delivery-revocation-result.json. No native model calls or unrelated device changes.
- Historical stage: other hosts were then pending. See bounded-run completion below for final host results; no aggregate five-host success claim.

## Candidate archive / background executable follow-up
- Background executable lookup now prefers stable per-host home launchers and validates the current OpenCode major before extraction. Service definitions receive only an explicit escaped PATH, never a serialized provider environment. Focused worker result: 22/22; independent path review found only the separate diagnostic-log issue, which was reproduced and fixed. No real launchd/systemd registration was performed.
- Sixth integrated run: 517 tests, 514 pass, 3 fail, 0 skipped. The three failures belong to concurrently introduced OpenCode runner TDD probes (missing planned exports), not the background executable regressions. This is an intermediate RED checkpoint, not a passing final suite.
- Actual website shell script through bash stdin, isolated HOME and Node 18, downloaded the candidate archive/checksum via a file release-base override: exit 0, version 0.14.0, all five hosts detected, HOME inventory unchanged in --plan. This verifies the candidate shell/archive path only; it does not make the public curl URL serve the unpublished candidate or prove real default service installation. Result: /private/tmp/37soul-delivery-candidate-shell-plan-result.json.
- Website integration branch feat/delivery-web contains auth c6fe1492 and protocol 83d6763b. Independent review found retained HTTP soul guidance still instructed retired raw writeback; a focused follow-up is required before integration acceptance. Main checkout unchanged.

## Seventh integrated checkpoint
- Runtime commit ec6aa8e adds background executable resolution, scoped read-only runtime evidence, event-specific Claude hook diagnosis and failure-log redaction. Native error-message canary RED: 6 tests/5 pass/1 fail; fixed focused native/path/Linux group: 20/20.
- Seventh packed full npm test: 529 tests, 529 pass, 0 failures, 0 cancelled, 0 skipped; smoke all checks passed. Required candidate archives and actual SHA-verified Node 18 executable were used. Log: /private/tmp/37soul-delivery-full-seventh.log.
- Website integration fixed HEAD 8abe8508e5e7441dd2c5c32202369e8690f1effd: 407 examples, 0 failures, 0 pending, 0 errors across 34 explicitly named spec files in separate DB/Redis13. Independent shared-guidance blocker review passed.
- OpenCode 2.0.32 loaded the actual managed bridge (one binding, two injected receipts), but actual generation failed with provider_quota_exceeded. Official auth inventory showed no other authorized provider. Stopped at 2/6 cumulative invocations; no credits purchased, no extraction/recall PASS claimed.
- Parent completed Codex official /hooks TUI approval for five reviewed managed commands in the isolated approved-codex HOME. Interface showed installed and active rows; no model prompt or trust-bypass flag. PTY exited0. Approval is a prerequisite only; managed functional loop is still required.
- Draft guide review fixed anonymous local-use sync instructions, restored explicit local Soul selection after login, and clarified extraction retries can consume quota. Root READMEs are not yet promoted pending required real-host acceptance.

## Bounded native run completion and cleanup
- Final cumulative model/native generation entries: Pi5, Claude5, Codex6, Hermes6, OpenCode2. No host exceeded six; no further calls are authorized under this recorded cap. Official management-only TUI approval sessions did not submit model prompts.
- Codex fresh recovery PASS: parent actually corrected owned host5 on the website, approved a new real device-code login selecting that Soul and approved its hooks through official TUI. Real sync restored the corrected active asset with zero old active assets; new native answer adopted Coral/Indigo/Pearl, fresh receipts included replacement and excluded original. Both learn/extraction/sync and post-correction adoption passed without re-teaching.
- Hermes core managed loop PASS: official consent, actual learn, automatic extraction, HTTP sync ACK, fresh native session independently confirmed from its native DB. Post-edit adoption was not attempted after automatic extraction reached cap6; do not claim that gate complete.
- All owned native daemons and private provider credential copies were stopped/removed. Parent removed four isolated browser-login HOME directories after validating their local test issuer or empty initial profile skeleton. Browser acceptance space57 finished; earlier space52 no longer existed and was not reused.
- Exact manifest cleanup of isolated local test owner2 succeeded: six owned Souls, nine devices and associated scoped credentials/assets were scoped and removed; fixture deleted. Initial cleanup hit a receipt dependency and rolled back; only temporary deletion order was corrected, with unchanged manifest guard. No shared DB/cache drop/flush. Puma8087 stopped; parent fresh check returned connection refused. Existing actual user installation, production and main checkouts untouched.
- Eighth full run: 547 tests, 544pass/3fail/0skip; all three old host-setup-guidance assertions expected extraction state inside the bridge row. Updated coverage now asserts separate hook-output/extraction observations and waiting/nonfatal states, preserving manual approval boundaries.
- Final independent source review additionally identified missing snapshot issuer guards in explicit sync/avatar and misleading credential doctor state. These issues were subsequently reproduced, fixed and independently reviewed; see final checkpoint below. No release completion is asserted.

## Final local checkpoint
- Eleventh required-pack npm test: 575 tests, 575 pass, 0 failures, 0 cancelled, 0 skipped; smoke all checks passed. Log /private/tmp/37soul-delivery-full-eleventh.log. Candidate source code has no changes after this verification.
- Final security RED:20 tests/2pass/18fail; offline-avatar preservation RED:2/2fail; additional index/cursor RED:28tests/23pass/5fail; final four-file login/CLI/sync regression:70/70. Associated prior positive fixtures were corrected to include actual snapshot/index issuers and genuine unregistered local Souls. No negative assertions were weakened.
- Independent final scope review found no remaining blocker in explicit sync/avatar/index/cursor checks. Default local registration and pending offline avatar semantics remain covered.
- New local source commits:69f22e7 (host diagnostic state) and2949818 (profile+account issuers before HTTP). Earlier source/runtime commits:dea4aa2,ec6aa8e,aeda78e. Website integration remains8abe8508 with407/407 named examples.
- Current result and remaining release gates are summarized in docs/reviews/2026-11-02-delivery-acceptance.md. Root README promotion, remote CI, publication, deployment and actual user installation were not performed.
