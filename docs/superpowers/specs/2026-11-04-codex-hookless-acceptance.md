# Codex hookless acceptance — 2026-11-04

## Implemented
Runtime 0.17.0 resolves the host-provided CODEX_THREAD_ID and validates one exact rollout, supports target-only connect and local bounded context restoration, and observes only explicitly attached native sessions. Codex installation removes only proven 37Soul handlers (with backup), preserves mixed foreign groups and native trust, and installs guidance instead of new hooks. Skill 6.14.0 and three-language website copy select that route; other hosts remain unchanged.

## Evidence
- Runtime npm test: 951 tests, 950 passed, 0 failed, 1 skipped (additional local Node18 binary absent; dedicated CI covers that floor). All 64 MCP smoke checks passed.
- Packed runtime: 7 checks, 6 passed, 0 failed, same Node18 skip. Packed version/manifest/digest/tar root were checked after pack.
- Focused runtime/connect/install/diagnostic checks: 94 passed. Eight native observer tests include an injected fixed model response through the production adapter, scheduler and asset store; no provider/model process was started.
- Skill Python policy checks: 30 passed; documented scoped-recall CLI harness: 5 passed.
- Rails named request specs local_agent_connect/current_local_soul_guides/agent_docs/for_agents_page: 58 examples, 0 failures (Ruby4.0.1). No Rails full suite was run against shared DB/Redis.
- Read-only actual Codex0.166.0 environment matched native context and exact rollout header. Discovery45ms.100 idle metadata-only observations: p50 0.063ms, p95 0.094ms on this machine. These are observer timings, not model-response or full-system latency. No profile writes or model calls occurred during that probe.

## Independent review and regressions
An isolated read-only reviewer found five important cases. Each was independently reproduced as a failing test and then fixed: revoked-period backfill, legacy rebind reattribution, cross-host explicit flags, in-place partial-turn substitution, and foreign cli.js hook ownership. All five regression tests pass. Frozen source windows and private cursor metadata remain outside wire DTOs.

## Limits
No new paid native-model evaluation was run: the earlier allowance is exhausted. Offline model stubs verify plumbing and budgets, not real-model adoption, provider latency/cost or every installed Codex version. Without before-request injection, compaction restoration depends on the Agent following its installed instructions and calling local context once. New sessions do not inherit another session's Soul.

## Delivery
Public release, CI, website deployment and local hook migration will be recorded after execution. They are separate from implementation acceptance.
