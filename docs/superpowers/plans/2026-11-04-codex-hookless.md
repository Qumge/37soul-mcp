# Codex hookless implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect and capture Codex sessions without exposing hook management to users.
**Architecture:** Host-provided ID plus validated rollout, bound-session background observation, existing single writer and scheduler.
**Tech Stack:** TypeScript, Node 18+, node:test; no new runtime dependency.
**Spec:** ../specs/2026-11-04-codex-hookless-design.md

## Global Constraints
No native trust edits; no paid model test calls; raw transcripts local; preserve other hosts and vendor hooks; retain scheduler budgets and frozen source provenance.

## Review Focus
Conflicting native IDs; duplicate rollout files; torn completion records; rebind/revocation during observation; unchanged long transcripts must not be rescanned.

### Task 1: Native identity and source
- [x] Failing acceptance: exact environment connect works without source pointer; conflicts/ambiguous files fail before HTTP.
- [x] Add bounded exact-ID discovery and CLI path; preserve explicit flags for other hosts.
- [x] Verify acceptance and existing connect suites.

### Task 2: Bound-session observation
- [x] Failing acceptance: native task completion yields exactly one frozen job; interrupts, partial records, rebinds and mutations do not cross boundaries.
- [x] Add local observation cursor and writer-serialized enqueue, integrate agentd and native turn rendering.
- [x] Verify offline scheduler and isolation using an injected model only.

### Task 3: Onboarding and local verification
- [x] Failing acceptance: migration removes only our handlers in mixed groups; repeated install keeps foreign config unchanged.
- [x] Update Codex installer/diagnostics, installed guidance and website prompts, add local bound context restoration.
- [x] Run full runtime suite, relevant skill/website checks; review fixed diff.
- [x] Back up and remove only local 37Soul Codex handlers; retest with absent handlers and report native-model acceptance separately.
