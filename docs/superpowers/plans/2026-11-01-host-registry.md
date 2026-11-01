# Host Registry Phase 0 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, following the user's explicit TDD and commit sequence.

**Goal:** Centralize the existing five hosts without changing behavior.

**Architecture:** `src/hosts/types.ts` defines HostSpec. Five host modules own installation, hook metadata/parsing, doctor checks and adapter factories; registry consumers retain orchestration and order. Shared helpers have no imports from install/hook/doctor.

**Tech Stack:** TypeScript ESM, node:test.

**Spec:** 37soul 仓库 `docs/superpowers/specs/2026-11-01-multi-host-agent-support-design.md` §5.1 and the user's Phase 0 task.

## Constraints

Only this worktree; no pushes, merges, release, version, fixture or existing-test changes. Keep all output, capabilities, protocol values and ordering. Preserve public install exports. Legacy daemon/parser/types and static plugin sources remain untouched.

## Review Focus

- Explicit reversed/duplicate host selection: plans/manifests retain registry order, install results retain selection order.
- Uninstall: Claude cleans all event entries before fragments; MCP removal remains after every host's file cleanup.
- Modified bridge files retain SHA-aware backup/preservation.
- Pi keeps no completed-turn parser and no per-host doctor checks.
- Unknown hook kinds retain payload parsing/spool behavior, without runtime-event emission.

## Tasks

1. [x] Add `test/hosts-registry.test.mjs`; verify missing registry failure. Baseline Claude fixture returns `["c-u6", "c-a5"]`.
2. [x] Add `src/hosts/{types,registry,instructions,hook-command,shared,claude-code,codex,opencode,hermes,pi}.ts`; move existing per-host logic without rewriting it. Define minimal extra dependency fields for existing hook command/doctor fallback paths. Build and run new contract test. Commit.
3. [x] Dispatch install plan/configure/manifest/uninstall via HOSTS, re-export old API. Test install plus registry; commit.
4. [x] Dispatch hook channel, completed-turn parser and runtime-event eligibility through HostSpec. Test hook plus registry; commit.
5. [x] Dispatch per-host doctor checks through HostSpec, preserving Pi's empty checks. Test install/doctor paths; commit.
6. [x] Derive native binaries/adapters and protocol/validation types. Test native/adapters/assets plus registry; commit.
7. [x] Review the whole diff, run `npm run build && npm test`, verify existing tests unchanged and worktree clean. Report commits, files, results and deferred work.

## Execution record

- Initial branch: `refactor/host-registry`, base `d8ae477`; clean worktree.
- RED: `node --test test/hosts-registry.test.mjs` failed with ERR_MODULE_NOT_FOUND for `dist/hosts/registry.js`.
- No plan approval pause: the user supplied the design, exact execution sequence and authorization to implement it.

- Registry GREEN: build and all four new registry tests pass; no consumer dispatch changed yet.

- Resumed review: retained ef54648/29c309c; corrected the skeleton's manifest timing with lazy host entries so bridge writers still run again after service/bin setup.
- Replayed ef54648 in an archive inside this worktree: valid baseline build, registry test fails with ERR_MODULE_NOT_FOUND for dist/hosts/registry.js. Added five consumer-dispatch tests; observed 4 pass / 5 fail before changing consumers, all nine green afterward. Existing tests unchanged.
- Focused: install 48/48; hook 23/23; native/adapters/assets/registry 57/57.
- Differential: default, reversed, duplicate selections, Linux and bridge modification during service setup all exactly match the archived baseline (plans/results/logs/configured host files/manifests/doctor/removal commands and order).
- Final npm run build && npm test: 393 tests, 391 pass, 0 fail, 2 skips; smoke all checks passed. Baseline: 383 tests, 381 pass, 0 fail, same 2 skips. An earlier full run hit one hook timing assertion (1189ms); no code/test/timeout/concurrency settings were changed to get the final pass.
- No host added, no real-account/model probe, no protocol values/fixtures/versions/plugin sources/legacy daemon parser changed. No push, merge, release or worktree removal.
- Final edge parity fix: null JSON payload originally reported reading session_id, but the skeleton read prompt first. Added a RED test for all five hosts and unknown, restored the legacy evaluation order, verified 33/33 hook+registry and repeated the full suite/smoke successfully. Registry now has 10 tests. Named-fix static review resolved.
