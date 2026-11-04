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

## Final public delivery and local verification

- Runtime [v0.16.2](https://github.com/Qumge/37soul-mcp/releases/tag/v0.16.2), tag24ccaca195469a8cff45998ad03fc8cb89a9151c, published as latest with four assets. Public VERSION, manifest, checksum and packed package all read back0.16.2. SHA256 `71d1e97bb2d94c1a5de448df52ced57ab736ab19c07c2793304e0ba39acaeb70`.
- Skill [v6.13.4](https://github.com/Qumge/37soul-skill/releases/tag/v6.13.4), taga34910d654fac43a658c61471e5c0867b9a8b275, merged/pushed and published. Main Python28/28 and offline native harness5/5.
- [Tag CI](https://github.com/Qumge/37soul-mcp/actions/runs/41813635785) and [public-service acceptance](https://github.com/Qumge/37soul-mcp/actions/runs/41814032414) passed. Public acceptance: Node18 tests944/pass944/fail0/skip0; Node20/24 tests944/pass943/fail0/skip1. The skip is the optional additional local Node18 binary check; the dedicated Node18 job executes it. Smoke checks passed. Ubuntu24.04 and macOS14 native services both produced PASS, including literal public curl installation,0.16.1→0.16.2 upgrade, repeat install, restart, uninstall/reinstall and data preservation. No model calls.
- Local runtime installed0.16.2 and IPC confirmed the running daemon version, launcher and service paths. Installed CLI bytes equal the public archive. Both scoped `credentials` and legacy `tokens`, account index, active profile, profile authorities, existing Soul/asset IDs and the complete Codex trust file fingerprint were preserved.
- Skill Installer downloaded the publicv6.13.4 tag to a staging directory; every changed file matched the git tag. Ten unchanged managed files were updated atomically after backup, preserving custom files. Codex and Claude symlinks point to this shared6.13.4 installation.
- Native Codex hook loading/trust remains unverified until reviewed by the user in `/hooks`. No actual screenshot-session attachment or trust approval was performed. After genuine native context arrives, the original target can be resumed without repeating the Soul selection. Gemini/Cursor retain their pre-existing unverified native-loading status.
- Main branches are pushed. Both task worktrees were removed after confirming them clean; branches retained. Pre-existing Skill-main `tests/__pycache__/` remains untouched.

Delivery deviations: Git HTTPS rejected the new runtime tag twice with HTTP500; official GitHub ref API created the same tag at the verified SHA without overwriting a ref. One Skill-tag API call used an invalid object value and was rejected422; the request was corrected to use the SHA read directly from git, and the returned ref was verified. The Skill staging tool's automatic-approval review timed out once and succeeded on its allowed retry. Public asset download encountered local timeout/HTTP2 framing errors; the same public bytes downloaded with HTTP1.1 and passed all checks. To avoid redownloading, local installation used that verified public archive and the same final CLI install step as the official script. Literal default public curl was separately verified on both hosted operating systems; no checksum/transport-security checks were bypassed.

Evidence: `/private/tmp/37soul-native-recovery-public/`, `37soul-native-recovery-installed-verified.json`, `37soul-native-recovery-skill-installed.json`, final full/Node18 logs and downloaded Linux/macOS service artifacts. The local backup contains managed Skill documents only; no credentials were published. This repair made no direct paid/native model evaluations, and makes no universal LLM-adherence guarantee.
