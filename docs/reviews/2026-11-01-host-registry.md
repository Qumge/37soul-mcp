# Host registry Phase 0 — completion review

Worktree: `/Users/jiangxin/projects/37soul-mcp/.worktrees/host-registry`  
Branch: `refactor/host-registry`  
Behavior baseline: `d8ae477` (the parent of the initial test commit).

## Reviewed existing work

- `ef54648`: retained. Its four characterization tests pin kind/home/file order, extraction coverage and Claude completed-turn refs. They do not by themselves detect consumers ignoring the registry.
- `29c309c`: retained and corrected. The skeleton had moved bridge manifest SHA/generation capture into configure and omitted the legacy second managed write after service/bin setup. Host manifest entries are now evaluated at the original manifest stage, preserving that second write and its backup semantics. Static independent audit confirmed this discrepancy and its resolution.

## Implementation

The five existing hosts own their detect home, plan/configure/manifest/uninstall, MCP removal commands, hook metadata and payload/completed-turn parsers, doctor checks, binary and adapter factory. Consumers look up/iterate HostSpec instead of branching by host kind.

Install results/logs retain selection order (including duplicate requests); plan and manifest retain canonical host order. Uninstall completes all host file cleanup before MCP removal. Public install exports and fallback hook commands remain available. Protocol enum values/order are unchanged; RuntimeKind and submittable kinds are derived. Gemini remains detected-but-unsupported.

`HostInstallDeps` and `HostDoctorDeps` retain nodePath/cliScriptPath because the existing no-launcher fallback needs them. HostInstallResult.manifestEntries uses bridge getters so entries are computed at the legacy second-write point. These are internal interface refinements permitted by the brief, not new user behavior.

## Files changed across this branch

- `src/install.ts`
- `src/hook.ts`
- `src/doctor.ts`
- `src/agentd/native-invoker.ts`
- `src/assets/protocol.ts`
- `src/assets/validation.ts`
- `src/hosts/claude-code.ts`
- `src/hosts/codex.ts`
- `src/hosts/opencode.ts`
- `src/hosts/hermes.ts`
- `src/hosts/pi.ts`
- `src/hosts/types.ts`
- `src/hosts/registry.ts`
- `src/hosts/shared.ts`
- `src/hosts/hook-command.ts`
- `src/hosts/instructions.ts`
- `test/hosts-registry.test.mjs`
- `docs/superpowers/plans/2026-11-01-host-registry.md`
- `docs/reviews/2026-11-01-host-registry.md`

## Commits

Retained:
- `ef54648` test(hosts): pin registry contract and existing file lists
- `29c309c` refactor(hosts): add HostSpec registry skeleton

Added:
- `4d0e0f7` test(hosts): require registry dispatch from consumer entry points
- `0ddf47b` refactor(install): dispatch host lifecycle through HostSpec
- `0484efe` refactor(hook): read host parsing and capabilities from HostSpec
- `90f9ad9` refactor(doctor): delegate per-host checks to HostSpec
- `90c4053` refactor(native): derive binaries and adapters from HostSpec
- `8103aa1` docs(hosts): record Phase 0 parity and full-suite verification
- `295ff1b` refactor(hook): preserve legacy payload error evaluation order
- Final evidence update is committed separately after the last full run.

All commits use the required Codex Co-Authored-By trailer.

## Verification

- Replayed the test-only commit inside an archived source tree in this worktree: after a successful baseline TypeScript build, the new test fails because `dist/hosts/registry.js` is absent. No source commit was reset/reverted and no old tests were changed. The already-built skeleton initially passed its four original tests, so consumer-dispatch RED tests were added rather than pretending the existing skeleton was absent.
- Before consumer implementation: `node --test test/hosts-registry.test.mjs` produced **9 tests, 4 pass, 5 fail**. After consumer implementation: all 9 pass. A final null-payload parity check exposed the skeleton's different evaluation order; the added 10th registry test first failed, then all 10 passed after restoring session_id-first evaluation. Hook + registry combined: 33 pass, 0 fail. Named-fix independent source review confirmed normal field precedence and the legacy error receipt.
- Existing focused install tests: **48 pass, 0 fail**.
- Existing hook tests: **23 pass, 0 fail**.
- Native/adapters/assets-contract/registry subset: **57 pass, 0 fail**.
- Final command: `npm run build && npm test` — **393 tests, 391 pass, 0 fail, 2 skipped**, followed by smoke **all checks passed**, exit 0. No concurrency flags or timeout changes.
- Archived baseline existing tests: **383 tests, 381 pass, 0 fail, 2 skipped**.
- Both skipped tests are baseline/environment conditions: no local Node 18 binary; no packed `release/` artifacts. The brief anticipated one skip, but this checkout has two; no release was built to hide that difference.
- First full run: **392 tests, 389 pass, 1 fail, 2 skipped**. Failure: `hook: falls back to the local cache when the API hangs, inside the 300ms budget` at `test/hook.test.mjs:78`, assertion at line 104: `hook must not block startup (took 1189ms)`. Focused hook and the archived full baseline passed; the unchanged final full run passed. This timing failure is disclosed, not removed by modifying a test.
- Independent final read-only review found no remaining concrete behavior mismatch in the branch diff.
- Five deterministic baseline-vs-current scenarios match by deep equality: default all-host selection, reversed selection, duplicate selection, Linux, and bridge files modified during service setup. Compared plan, installed result, user-visible logs, manifest entries/order, host config file contents, doctor output, removed list and command order. The last scenario verifies the skeleton timing correction.
- Existing tests, plugin/adapter sources, legacy daemon/types, protocol fixtures and version files have empty diffs against d8ae477. No source under hosts imports install/hook/doctor. Temporary baseline/test artifacts are removed after recording this report.

## Boundaries and follow-ups

No new host or capability, no opt-in change, no protocol/fixture/version change. Pi extract remains unsupported; Codex/OpenCode/Hermes/Pi inject remain delivered:false. No real account, paid model or live host probe occurred. No push, merge, package publication, release or worktree deletion.

Deferred as required: legacy `daemon.ts` parser choice and `IngestibleAgentKind`; bridge implementation changes and real trust/injection/extraction verification; new-host decisions (including Cursor SQLite transcript/privacy boundary and Gemini), runtime distribution and website host tables. None were implemented here.
