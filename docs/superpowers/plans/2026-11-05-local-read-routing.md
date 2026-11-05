# Local read routing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement inline.

**Goal:** Answer connected-Soul read requests through the existing local login without operator/browser detours.
**Architecture:** Bounded capability hints on connect/context, first-priority Skill intent table, existing scoped whoami/recall implementations.
**Tech Stack:** TypeScript/node:test, Skill Markdown with an offline executable-guide harness, Rails named public-doc spec.
**Spec:** ../specs/2026-11-05-local-read-routing.md

## Global Constraints
No new fetch on ordinary turns/connect; no credential exposure, consent expansion, paid model test calls or new write actions; retain Codex hookless and other hosts' verified native context.

## Review Focus
Stale post timestamps; absent vs empty fields; photo viewing vs paid generation; malformed host/runtime hint injection; context recovery after host ID is forgotten; issuer/consent denial remains local.

### Task 1: Discoverable runtime reads
- [x] Add failing connect/context behavior tests for scoped executable hints and budget; expand full snapshot coverage.
- [x] Implement bounded hint generation and budgeted context recovery, without changing snapshot authorization.
- [x] Verify focused and full runtime tests.

### Task 2: Skill and public guide
- [x] Add failing executable-guide cases for posts/media/social reads and scoped memories.
- [x] Correct top-level intent routing and local/operator boundaries, plus missing/stale/limited result handling.
- [x] Verify full Skill checks and named public-doc spec; independent review.

### Task 3: Delivery
- [x] Release, install and verify approved patch updates; preserve account/Soul/assets and foreign hooks.
- [x] Report live read evidence and model-evaluation limits separately; clean task worktrees after merge/push.
