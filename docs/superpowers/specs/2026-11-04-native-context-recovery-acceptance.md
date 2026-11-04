# Native-context recovery repair — acceptance

## Approved behavior and scope

The user approved fixing the recovery logic after a Codex agent asked them to repeat an already explicit connection request for Lila Kensington (Host276). The selected target must survive recovery in the conversation. Missing native context is not a reason to guess a session, repeat login/OAuth, edit native trust, switch Souls/defaults or claim attachment.

Runtime core changes cover failure-only CLI diagnostics, Codex doctor wording and a read-only repair to the doctor storage-opening path. Skill6.13.4 changes its missing-context branch and English/Chinese/Japanese references. Healthy exact-target connection remains direct; no routine doctor preflight or added network/model calls.

## Implementation

- Missing native flags or source retain the concrete requested numeric Host ID/exact name in stderr and point to `37soul doctor` plus native hook approval/loading.
- Codex doctor retains missing/malformed/outdated versus installed-but-unverified distinctions. An installed definition without receipts is unverified, not proof of untrusted status. Native review stays in `/hooks`; the user owns approval. No blanket restart/new-session requirement.
- Skill runs one bounded read-only diagnosis only on failure, preserves the original target and resumes the same request with actual managed context. A short “continue” is sufficient only if native readiness is verified and a normal next turn is still needed to refresh context. No repeated selection or retry loop.
- Source/consent/credential checks, native flags, session IDs, binding revisions and healthy round trips are unchanged. There is no new persistent default-Soul feature.

## RED/GREEN evidence

| Check | RED | GREEN |
| --- | --- | --- |
| New real CLI/doctor recovery regressions | 5tests:4fail/1controlpass | 5/5 |
| Complete-CLI diagnostic identity side effects | 7tests:5pass/2correctRED | 7/7 focused |
| Related connect/account/host regressions | — | 63/63 |
| All affected setup/install/doctor guidance | obsolete assertions required new session | 74/74 |
| Skill Python contracts | initially27tests with12failure/subtest points | final28/28 |
| Read-only automatic diagnostic version gate | 28tests,2subtest failures | 28/28 |
| Additional stale public README instruction | 27tests,1failure | 27/27 |
| Skill6.13.4 version agreement | 27tests,1failure | 27/27 |
| Skill offline native command/store harness | unchanged path | 5/5 |
| Node24 packed runtime `npm test` | first942:940pass/2obsoletewordingfail | final944/944,0fail/skip;64smoke |
| Node18 runtime | — | 944/944,0fail/skip;64smoke |

The first new runtime test execution had a fixture setup error: opening an empty store without a transaction had not created the profile directory. The fixture was corrected and rerun before production edits; it is not counted as a production RED. Existing tests that locked in unconditional “new session/next message” guidance were intentionally updated to the approved recovery contract, with other host and safety assertions retained. The first full-suite two failures were additional versions of that obsolete wording, not ignored regressions.

CLI regression tests use isolated homes, guard all network access and compare snapshots, account configuration and native trust files before/after. Both missing-context branches leave them unchanged. No real account or native-session attachment was attempted. Complete-CLI doctor tests also compare the entire isolated HOME tree when device metadata or the profile directory is missing.

## Review and evaluation limits

One fresh, fixed-range whole-fix review covered runtime b0ff273..c4b4dfb and Skill03d11f1..034a0fd. It found one Important P2 issue: full doctor opened stores in bootstrap mode and could create device.json when absent, despite the new Skill calling it read-only. Two added full-CLI tests reproduced device creation beside an existing snapshot and creation of an index-only profile directory. The fix passes an explicit diagnostic-only device sentinel at both doctor read sites, using the existing recall-read-only approach: reads still validate snapshots/backups, never call transact, and never persist the sentinel. Active-profile/credential checks remain independent. Final focused30/30 and full Node24/18 each944/944 pass. The reviewer confirmed the mechanism against the already-reviewed store code, with no remaining concrete concern, while explicitly not claiming a review of later HEAD or native-host adoption. Skill additionally gates automatic diagnosis on Runtime0.16.2 or later; older/unknown installations must verify/upgrade before doctor, never use an older doctor as the version probe.

The actual reported screenshot plus the prior Skill wording establish the old failure. New Skill checks are deterministic documentation contracts and offline command execution, not a new live-model behavior evaluation. The earlier paid native-model allowance is exhausted; this repair adds no direct paid/native model evaluations. No claim that every model follows the guidance or that native trust/loading has been approved on the user's behalf.

## Delivery

At implementation acceptance: Runtime0.16.2 code2699f9f5c5d6eadb47f1ac37e8f7da7a18cd89e5 and Skill6.13.4 codea34910d are committed and locally verified. Public CI, release and installation results will be appended after the authorized delivery steps. No native trust approvals are included.

The runtime and Skill repositories use separate worktrees/commits. Original Skill-main `tests/__pycache__/` is pre-existing and preserved. Runtime distribution uses GitHub Release+official install.sh, never npm publication. Native Codex trust decisions are outside installation scope.
