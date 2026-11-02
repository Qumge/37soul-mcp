# Delivery readiness ledger

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
- Task 1: in progress, new raw-egress retirement acceptance tests being written first.
- Task 2 runtime: in progress, issuer-bound credentials tests first.
- Task 2 website: in progress, scoped ban/auth tests first.
- Task 3 Pi: in progress, source bridge/parser/native extraction tests first.
- Task 4: not complete; new-session cloud freshness design under review.
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
- Latest integrated candidate run /private/tmp/37soul-delivery-full-fifth.log: 503 tests, 503 pass, 0 fail, 0 skipped; smoke all checks passed. Node floor 18.20.8 was fetched from nodejs.org and SHA-256 verified; pack tests were mandatory. This is not five-host native acceptance.
- Linux service activation now restarts new ExecStart after reload/enable and restores old unit on failure; first-install failure disables newly enabled service. 8 focused tests passed with injected systemctl, not real Linux execution.
- CLI sync without valid profile now fails actionably rather than returning false success; default commands follow active profile, bulk sync is explicit --all-profiles.

## Real local acceptance
- Browser sign-in -> real device code -> selecting synthetic Soul -> approval -> CLI login exit 0 -> 5 issuer-scoped credentials -> first Soul restore completed against local Rails 8087 in dedicated test DB. Final candidate login persists active browser-delivery and hook resolver matches it.
- Pi 1.4.0 managed extension -> actual Stop source -> foreground daemon/native extraction -> active local asset -> real Rails sync -> real AssetWriter correction -> pull -> fresh Pi session adopted correction without answer in human prompt. 3 new native calls, cumulative Pi 5. It does not claim a default global launchd install.
- Browser then displayed the actual synced Pi asset and successfully edited it, preserving two historical versions. Initial browser save was blocked by test Rack allowlist not recognizing canonical host slugs; test gate fixed, application code unaffected.
- Existing user runtime/host config, main branches and public v0.13.4 remain unchanged. Candidate source version is 0.14.0, not published.
- Other four hosts, complete fresh account revocation checks, final docs promotion and release remain in progress; no aggregate five-host success claim.
