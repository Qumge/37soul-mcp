# Install E2E feedback — local implementation and review

Base: c84d520. Branch: fix/runtime-install-feedback. Website work is isolated on fix/install-host-list in the other repository. This is a behavior-fix task after Phase 0, not part of its pure-refactor branch. No release, push, merge, production account or actual-user daemon operation occurred.

## Findings handled

| Input | Local change | Evidence / boundary |
| --- | --- | --- |
| B1 cached launchd ProgramArguments | Inspect the GUI-domain job; verify program/arguments belong to this HOME; atomically stage plist; bootout then bootstrap. Restore old plist and bootstrap old service on new-bootstrap exit/exception. Refuse to stop an existing job without a readable previous plist. | Tests cover cached old runtime, foreign HOME, environment text that merely mentions this HOME, nonzero and thrown bootstrap failures, missing rollback config. All commands are stubs. Actual user's launchd was not touched. Linux service lifecycle was not changed. |
| B2 installed runtime cannot reinstall / plan 0.0.0 | Resolve version from package, installed marker, then versioned runtime directory. Recognize the flattened dist/{cli,index}.js shape only when the source .installed marker declares bundle mode. New runtime package metadata carries its version. | Tests include old minimal type-only package metadata, copying an installed bundle, and full self-reinstall from an existing runtime back into the same HOME. No package version bump or new release. |
| B3 false service green / old running runtime | Add a cheap local IPC health command with pid, entrypoint and agentd identity; optional client request total deadline, cleared on completion. Doctor checks real daemon even if no service entry was written, rejects a transient writer, compares canonical running/configured runtime directories, and makes failed readiness nonzero. Installer allows bounded startup settling and does not print local-ready on failure. | Tests include dead writer, old live entrypoint, matching entrypoint, real isolated agentd-shaped child + IPC, partial-byte peer that cannot extend the total deadline, and failed-install CLI output. Does not claim a real host/model integration probe. Old writers without health support fail closed rather than appearing healthy. |
| B4 URL base | CLI and daemon resolve ENV > persisted config > production. Soul links retain HTTP, port and path prefix. Device login rebuilds the approval URL using the configured base, preserving server query/hash and the device-code polling payload; both displayed URL and browser target use it. | Six list/sync tests plus approval display/browser/API path test. Server development OAuth origin configuration is unchanged; CLI no longer blindly copies its incorrect origin. Production OAuth issuer rules unchanged. |
| B5 manual host gates | Codex: review/approve /hooks and open a new session; OpenCode: enable/review plugin and restart; Hermes: explain local capture vs unverified/disabled model extraction. Explain what manual action enables, keep trust/events/extraction/injection reports honest. | Three guidance tests and existing trust-state checks. No automatic trust approval, capability upgrade or model call. |

## TDD and verification

- Initial B1/B2/B3 regression file: 8 tests, 8 failures before implementation.
- B4: six display tests, 4 pass / 2 fail before fixing persisted-base handling. B5: three valid behavior failures before guidance was added; an earlier Codex setup directory error was corrected before counting the valid RED.
- Additional observed REDs: transient writer counted as background; wrong login approval origin; false successful-install readiness; environment path mistaken for launchd ownership; bootstrap rollback absent (two tests); missing previous plist; partial-byte IPC response bypassing idle timeout.
- Final related serial command:
  `node --test --test-concurrency=1 test/runtime-install-feedback.test.mjs test/install.test.mjs test/cli-install-feedback.test.mjs test/host-setup-guidance.test.mjs`
  **75 tests, 75 pass, 0 fail, 0 skip.**
- Final **unmodified `npm test`**: build and bundle passed; **421 tests, 419 pass, 0 fail, 2 skipped**; smoke **all checks passed**, exit 0.
- Skips: no local Node 18 binary; no packed release tree. No release artifacts were generated to conceal those conditions.
- Machine load exceeded 700 during validation. An earlier parallel focused run timed out in `install: hoisted npm layout (bundles only, no node_modules) serves MCP through the launcher` (`initialize timed out`). No timeout assertion was increased; serial focused and the final default npm test passed. NODE_OPTIONS cannot set test-concurrency on this Node; that attempted command exited 9 before running tests. Final npm test ran without that option.
- Existing install fixtures now represent an absent launchd job with its real nonzero print result, assert bootstrap instead of obsolete load, and supply a live daemon response when registration itself is stubbed. Exact old guidance-text assertions now check the authorized next-step/boundary wording; trust/ok assertions remain. These are intentional behavior-change expectations, not a Phase 0 test adjustment.
- Independent read-only review found upgrade rollback, ownership and total-deadline issues. Each received a RED test and correction; named source rechecks resolved them. No user assets were deleted.

## Files

Runtime source: src/service.ts, src/install.ts, src/doctor.ts, src/runtime-health.ts, src/local/writer.ts, src/cli.ts, src/i18n.ts, src/hosts/codex.ts, src/hosts/opencode.ts, src/hosts/hermes.ts.

Tests: test/runtime-install-feedback.test.mjs, test/cli-install-feedback.test.mjs, test/host-setup-guidance.test.mjs, test/install.test.mjs. This report is the only additional documentation file.

## Website work and A2 decision

Website branch fix/install-host-list:
- 86e9b4db: derive /for-agents host names from AgentKind::INGESTIBLE using existing translated approval labels. EN/ZH/JA and catalog-order mutation tests cover Pi and prevent a second hardcoded list.
- 8baeeab1: account deletion proposal only, at docs/decisions/2026-11-01-account-deletion-proposal.md.
- A1 TDD: 6 failures before implementation; new host-list plus agent_soul_page: 33 examples, 0 failures, independently repeated with isolated local DB/Redis.
- Wider related run: 65 examples, 1 failure, from unchanged for_agents_page_spec.rb:115 expecting old homepage class lp-nav__for-agents. Not changed as part of this task.

A2 recommends final confirmation -> immediate account lock and credential/device revocation -> asynchronous auditable cloud cleanup. Existing remove/unremove is recoverable, including login restoration, not an irreversible deletion lifecycle. Cloud/local/shared-content/billing/retention distinctions and approval decisions are documented. No account/auth/billing/deletion behavior was implemented, no production data queried. Legal/compliance conclusions and a new deletion SLA are not claimed.

## Delivery status

Implemented and verified locally only. To reach users, runtime changes still need reviewed packaging/version release and distribution; A1 still needs website deployment. No push/merge/deploy, paid generation, real account verification, or modification of the machine installation described by pi occurred. Local worktrees and branches remain for review.
