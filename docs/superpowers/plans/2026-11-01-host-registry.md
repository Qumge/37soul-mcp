# Host Registry Phase 0 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, following the user's explicit TDD and commit sequence.

**Goal:** Centralize the existing five hosts without changing behavior.

**Architecture:** `src/hosts/types.ts` defines HostSpec. Five host modules own installation, hook metadata/parsing, doctor checks and adapter factories; registry consumers retain orchestration and order. Shared helpers have no imports from install/hook/doctor.

**Tech Stack:** TypeScript ESM, node:test.

**Spec:** `/Users/jiangxin/projects/37soul/docs/superpowers/specs/2026-11-01-multi-host-agent-support-design.md` §5.1 and the user's Phase 0 task.

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
2. [ ] Add `src/hosts/{types,registry,instructions,hook-command,shared,claude-code,codex,opencode,hermes,pi}.ts`; move existing per-host logic without rewriting it. Define minimal extra dependency fields for existing hook command/doctor fallback paths. Build and run new contract test. Commit.
3. [ ] Dispatch install plan/configure/manifest/uninstall via HOSTS, re-export old API. Test install plus registry; commit.
4. [ ] Dispatch hook channel, completed-turn parser and runtime-event eligibility through HostSpec. Test hook plus registry; commit.
5. [ ] Dispatch per-host doctor checks through HostSpec, preserving Pi's empty checks. Test install/doctor paths; commit.
6. [ ] Derive native binaries/adapters and protocol/validation types. Test native/adapters/assets plus registry; commit.
7. [ ] Review the whole diff, run `npm run build && npm test`, verify existing tests unchanged and worktree clean. Report commits, files, results and deferred work.

## Execution record

- Initial branch: `refactor/host-registry`, base `d8ae477`; clean worktree.
- RED: `node --test test/hosts-registry.test.mjs` failed with ERR_MODULE_NOT_FOUND for `dist/hosts/registry.js`.
- No plan approval pause: the user supplied the design, exact execution sequence and authorization to implement it.
