# Lightweight runtime implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox syntax.

**Goal:** Bound the latency, context growth and background model spend added by a connected Soul.
**Architecture:** Reuse durable watermarks and native adapters. Add a production-only batching wrapper with per-job output parsing, atomic claim/budget reservation, bounded source text, per-binding delivery cache and compact connect output.
**Tech Stack:** TypeScript/Node>=18, existing esbuild, node:test; no dependencies.
**Spec:** docs/superpowers/specs/2026-11-04-lightweight-runtime-design.md

## Global Constraints
Only runtime worktree; preserve all auth/consents/source boundaries/hosts, no raw upload or HOME edits. No new dependencies. Hooks300ms/50ms; model60s; drain concurrency1. Batch<=3same-binding jobs,90sidle; input<=24576bytes, turn<=6144bytes, output allowance1024; profile40calls/200000units/day, session20calls/50000units/day. No paid models without separate bounded user authorization. No merge/push or release in this implementation.

## Review Focus
- Exhausted/day rollover/restart/concurrent worker: leave pending, no wasted attempts, preserve budget.
- Different account/device/runtime/session/Soul/binding revision: never batch or share injection state.
- Frozen source replaced/truncated during preparation/model return: refuse stale commit.
- Compact/reset/resume/SessionStart and failed delivery: restore full output, don't manufacture receipts.
- Huge or injected tool text; missing/duplicate/reordered foreign batch job: bounded input, per-job provenance, explicit errors.

### Task1: Bound extraction input and implement native batch adapter
**Files:** create src/extraction/compact-input.ts, src/extraction/batch-adapter.ts, test/lightweight-input.test.mjs, test/lightweight-batch.test.mjs; modify src/adapters/types.ts, src/adapters/claude-code.ts, src/agentd/native-invoker.ts.
**Interfaces:** optional RuntimeAdapter.prepare(request) metadata and extractBatch(requests): Promise<ExtractionResult[]>; wrapper prepares via existing adapter with an intercepted no-model invoke, and reuses existing adapter parsing per job. Shared native JSON unwrapping exported without changing single-job behavior.
- [x] Write behavioral specs: binary/duplicate tools bounded, human provenance preserved, oversized human deferred; three actual adapter requests make one injected native call with correctly mapped outputs; errors/IDs/missing-source never become empty success.
- [x] Run named new specs RED; resolve setup errors before production edits.
- [x] Implement compact input at shared extraction builder and batch wrapper wired only in production createExtractAdapters. Add Claude-only output env bound.
- [x] Run named specs plus extraction-output,extraction-limits,native-invoker and adapter focused specs GREEN; commit.

### Task2: Durable batching gate and atomic resource budgets
**Files:** create src/extraction/resource-budget.ts,test/lightweight-scheduler.test.mjs; modify src/extraction/scheduler.ts,src/local/store.ts,src/local/writer.ts,src/adapters/types.ts,src/extraction/diagnostics.ts.
**Interfaces:** optional watermark queued_at; optional snapshot resource_usage metadata. reserve_extraction_batch writer command validates/claims group and reserves atomically; production metadata-aware adapters batch at3/90s/explicit, legacy injected adapters retain immediate behavior.
- [x] Write real writer tests RED: first ordinary remains pending,3batch onecall,90sflush,explicit immediate, cross-session separation, budget deferral noattempt,UTCrollover/restart,concurrentclaim,stalebinding and source. Expected missing behavior, not test harness errors.
- [x] Implement gates, bounded daily ledger, resume old pending entries, diagnostic aggregates; no model in writer.
- [x] Run new tests plus extraction and daemon targeted suites GREEN; commit.

### Task3: Incremental bounded hook delivery with restoration
**Files:** create src/agentd/context-delivery.ts,test/lightweight-context.test.mjs; modify src/hook.ts,src/assets/context.ts.
**Interfaces:** exact binding-scoped context digest/source epoch cache, atomic0600 metadata; record only after stdout succeeds. Invalidating lifecycle events permit next full delivery.
- [x] Write real hook tests RED for unchanged prompt suppression, changed memory delivery, SessionStart/resume/compact restore, session isolation, output failure retry,4096bytebound and no mutation of stored assets.
- [x] Implement per-session cache and hook budget4096/identity2048 using selector optional limits without changing cloud contract defaults.
- [x] Run new and existing hook/context fixtures GREEN; commit.

### Task4: Compact connection output and bounded diagnostics
**Files:** create src/local/compact-identity.ts,test/lightweight-connect.test.mjs; modify src/cli.ts,src/local/agent-connect.ts,src/doctor.ts,src/agentd/native-invoker.ts,README.md,README.zh-CN.md,README.ja.md.
**Interfaces:** compactConnectionIdentity(identity) preserves authority/requiredpersona and returns only connection necessities; whoami unchanged. Existing doctor gets aggregate pending/budget counters, no private text.
- [x] Write real CLI connect tests RED: compact result contains attached/basic persona/mood, omits rich media/long feed; whoami full; revoked/auth/racing-profile tests unchanged.
- [x] Implement projection and honest docs explaining delay/budgets/locality.
- [x] Run focused connect/doctor contracts GREEN; commit.

### Task5: Acceptance and whole branch review
**Files:** create test/lightweight-acceptance.test.mjs,docs/superpowers/specs/2026-11-04-lightweight-runtime-acceptance.md.
- [x] Add behavioral regression/benchmark using local fake native transport and actual hooks/writer. Measure batch calls,bytes,latency; no paid model.
- [x] Run npm test after packing release artifact; inspect exact counts/skips and source changes.
- [x] Fresh whole-branch review, repair substantive findings RED/GREEN, rerun affected/fullsuite as warranted.
- [x] Commit acceptance evidence; report changes, benchmark bounds, commit hashes, deviations and explicitly unshipped state.

## Acceptance refinements
User separately authorized3real DeepSeek requests plus1recheck; all4 consumed, no further paid calls. Review extended Task5 to source pointer retention, fresh single/batch revalidation, durable source diagnostics, cross-session priority and linear tool compaction; see acceptance report for RED/GREEN evidence. Native one-turn stream normalization is covered by test/lightweight-native-output.test.mjs. Retiring Claude per-tool hooks adds src/hosts/claude-code.ts, test/lightweight-tool-hooks.test.mjs and updates2install expectations to the new subscription contract, preserving legacy cleanup coverage. Final whole suite/packing evidence is in the acceptance report.
