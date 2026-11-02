# 37Soul Delivery Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development. Steps use checkbox syntax. User has requested execution; do not ask again for routine reversible implementation.

**Goal:** Complete the promised current-protocol five-host product before simplifying the public onboarding documentation.

**Architecture:** One assets-only runtime; local source readers remain local. Stop legacy raw egress structurally, bind credentials to their server, and close native host extraction/context paths before qualifying releases. Preserve the separate website account/MCP features unless their deprecated transcript protocol is explicitly retired.

**Tech Stack:** TypeScript/Node ESM, native host bridges, Rails, scoped tests and isolated fixtures.

**Spec:** docs/superpowers/specs/2026-11-02-delivery-ready.md

## Global Constraints
- No old protocol/host version compatibility requirement; no destructive reset or automatic deletion of user assets.
- Never bypass host trust or report fixture success as native success.
- Only repository-local worktrees; runtime branch feat/delivery-ready.
- No unapproved publication or changes to actual user host configuration.
- Rails tests must use isolated state; no concurrent shared yu_test suite.

## Review Focus
- Damaged/missing mode index plus stored tokens and raw spool: zero transcript network egress (Task 1).
- Server-origin switch with valid old scoped credentials: zero old Bearer transmission (Task 2).
- Native host trust/load failure: actionable failure, no false delivered receipt (Task 3).
- Website correction before a new session and revocation after cached injection: revised context or denied context, no stale private disclosure (Task 4).
- Fresh install from published artifact using literal README commands: complete success or truthful recoverable error (Task 5).

### Task 1: Eliminate runtime legacy raw egress
Files: src/cli.ts, src/agentd/daemon.ts, src/index.ts; focused test files test/raw-egress-retirement.test.mjs, test/agentd.test.mjs, test/assets-mode.test.mjs, test/smoke.mjs, plus new acceptance tests selected after reading their harness.
Interfaces: agentd always receives no legacy tokens and no transcript fallback; local source-index/extraction remains functional; stdio tool list no longer advertises raw writeback.
- [x] Add failing probes: missing/damaged accounts metadata with populated legacy config must never send transcript/turn/facts/checkpoint bodies.
- [x] Run each probe RED and identify the real failure.
- [x] Remove raw-egress entry paths and deprecated stdio tools rather than adding mode fallbacks; preserve current hosted account actions.
- [x] Update old-protocol tests only to reflect explicitly retired behavior; retain equivalent coverage for current contract. Run focused tests then full npm test.
- [x] Independent diff review; record exact evidence and commit.

### Task 2: Issuer-bound credentials and account state
Runtime files: src/agentd/credentials.ts, src/install.ts, src/sync/client.ts, src/agentd/state.ts and their focused tests. Website files chosen in separate website plan/worktree after source audit.
Interfaces: selectCredentials must enforce normalized issuing endpoint equality; all consumers share this check.
- [x] RED: server A credential cannot be selected/sent to server B, including install endpoint switch; same issuer remains usable; malformed endpoint fails closed.
- [x] Bind issuer at login, preserve credentials on same-server reinstall, reject cross-server reuse with actionable login requirement.
- [x] RED then GREEN account ban authentication across PAT, MCP, soul sync and mobile using isolated website tests; do not redefine removed-account lifecycle silently.
- [x] Run focused checks and independent review; commit per repository.

### Task 3: Five native hosts
Files: src/adapters/pi.ts, src/adapters/plugins/*, src/hosts/*, src/agentd/native-invoker.ts and focused adapter/native tests as evidenced by audit.
Interfaces: extract returns validated ExtractionResult; bridge delivery is recorded only on actual supported delivery, capability probes reflect observed host versions.
- [x] Add failing Pi native extraction contract with current documented CLI; implement validated structured output and recursion guards.
- [ ] Pin one current tested host API per host; remove old-generation branches only with replacement coverage.
- [ ] Run hook/context/extraction acceptance separately for all five hosts; complete receive/consume receipt semantics where host APIs allow.
- [ ] Run native tests with synthetic context and isolated HOME, no user transcripts. Any paid or host trust actions require existing authorization or explicit consent.

### Task 4: Real cross-session closed loop
Files: new reproducible acceptance runner/test with server+native fixtures, docs/reviews evidence; website changes require coordinated plan if exposed.
- [ ] Fresh local Soul -> native context -> synthetic stable preference -> extraction -> asset persistence -> authorized push.
- [ ] Website correction -> pull -> fresh session observes corrected identity/asset for every supported host.
- [x] Revoke device -> subsequent session cannot use cached private assets; local-only unconsented assets stay local.
- [x] Preserve versions, artifact digest and privacy-negative observations; no skips count as release passes.

### Task 5: Public documentation and release gates
Files: README.md, README.zh-CN.md, README.ja.md; release verification scripts/workflow tests only where actual omissions require changes.
- [ ] Execute literal onboarding commands in isolated HOME from packed artifact, including copy/paste syntax and approval instructions.
- [ ] Replace obsolete 383-test/historical caveats with user actions after capabilities actually pass; move internal evidence into docs/reviews.
- [ ] Verify Node floor and tarball tests in appropriate CI; no environment skips substitute for support-floor checks.
- [x] Full npm test, packed executable and installer checksum/layout tests; independent final review.
- [x] Report implemented/committed/tested/real-host-verified/released status separately. Publish only under explicit release authorization for this change.

## Execution closeout — 2026-11-02

Local implementation and regression are saved; final required-pack npm test575/575, website named specs407/407. Bounded real generation entry caps were respected (Claude5/Codex6/OpenCode2/Hermes6/Pi5). Four core native loops passed; Pi/Claude/Codex correction adoption passed. Remaining gates: OpenCode usable quota, Hermes correction under a new bounded budget, clean-OS default background install/upgrade and remote CI. Public README promotion and publication remain unperformed. See docs/reviews/2026-11-02-delivery-acceptance.md.
