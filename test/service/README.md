# Clean OS default service acceptance

Run pure checks anywhere (no service operations):

```sh
node --check test/service/acceptance.mjs
node --test test/service/acceptance.test.mjs
```

The real harness **refuses local and self-hosted execution**. Do not override its
runner guard on a personal machine. It uses the disposable runner's actual HOME,
launchd GUI domain or systemd user manager; it does not redirect HOME or mock services.

Parent integration/CI commands after pushing the combined candidate branch:

```sh
gh workflow run release-runtime.yml --ref <ci-branch> \
  -f service_acceptance=true -f baseline_ref=632f60695d4d65583d17c45db663a1c8eabef672
gh run list --workflow release-runtime.yml
gh run watch <run-id> --exit-status
gh run download <run-id> --dir service-results
```

This extends the existing registered release workflow: parent can dispatch the
combined branch with `--ref` without first merging product changes to main.
For `baseline_ref`, pass the complete 40-character commit SHA: checkout treats an
abbreviated SHA as a branch/tag name, so `632f606` fails before packing.
The existing verification matrix remains; native acceptance only runs on manual
dispatch when `service_acceptance` is true (default). No push/tag native-service
trigger, merge, publication, paid VM or model call is added.
The installer is an exact test fixture snapshot of `Qumge/37soul` commit
`8abe8508`, `public/install.sh`. `fixtures/provenance.json` records its full commit
and SHA-256; the build job verifies that checksum. This avoids cross-private-repo
tokens and leaves the product installer untouched. Parent must update this fixture
and provenance if the intended installer changes. This is not live website delivery.

The workflow packs baseline and candidate once in one Linux build job, then both
OS jobs download the identical `service-runtime-inputs` artifact. It contains all
four candidate release files, baseline release files, installer and exact source
SHAs. After both native jobs pass, parent must publish those candidate files
directly; do not repack. Artifacts expire after 14 days.
Its real harness command (only on the hosted runner) is:

```sh
node test/service/acceptance.mjs \
  service-inputs/baseline/release service-inputs/candidate/release \
  service-inputs/install.sh service-evidence
```

Linux explicitly starts a real user@UID systemd manager and establishes its D-Bus
session. macOS requires `launchctl print gui/UID` to succeed. Missing manager/GUI,
nonzero default installer exit, health mismatch, or lifecycle failure is a failure,
never a skip. Per-process deadlines are 90s, health retry is bounded to 40 attempts
with 500ms backoff (IPC timeout 1.5s), and each OS job is capped at 15 minutes.

Coverage:

1. Baseline default **no-argument** HTTP installer on the clean OS, with checksum download.
2. Candidate default upgrade; baseline PID exits and candidate release bytes run.
3. Candidate repeated default install replaces the running PID.
4. Real manager restart, new PID, healthy writer, data unchanged.
5. Candidate uninstall: service disabled/unregistered, PID gone, launcher/runtime/socket
   removed, profiles and archives retained byte for byte.
6. Candidate default reinstall on the retained user data, with new healthy PID and
   exact candidate bytes; no harness `enable` or disabled-state reset is allowed.
7. Final uninstall repeats all service removal and data preservation checks.

macOS artifacts record `launchctl print-disabled` on the clean OS and after each
health/uninstall stage. The old release is never installed after candidate uninstall:
this avoids contaminating the old-version setup with the candidate's disabled
state. Candidate reinstall must recover that state through its own installer.
The earlier run `41399296693` remains evidence of the old ordering's failed
`02b-baseline` stage; it is not ignored or reclassified as PASS.

Every health stage correlates the manager's PID with a real IPC `health` response,
requires `agentd: true`, verifies its exact installed bundle path and package
version, checks installed bundle SHA-256 against the actual tarball bytes, and
checks the daemon remains stable. Empty `.claude/projects` is only a host-detection
fixture; no Claude executable, credentials, real conversations or extraction inputs
are supplied. No native model invocation occurs.

Artifacts contain complete harness stdout/stderr, installer logs, manager states,
SHA inputs, observations and an always-written job result JSON. These are synthetic
runner data only; profile snapshots and archive contents are never uploaded.
Only a completely successful run writes `PASS.json`; observations alone are not PASS.
Failure cleanup attempts the installed CLI's uninstall; the VM is discarded regardless.

Limits: this order tests a clean baseline, real candidate upgrade and candidate
reinstall with retained data; it does not separately test candidate first install
on a VM that has never had the baseline. Manager restart is tested, **not VM
reboot/login persistence**. This does
not test host hooks/model extraction, authenticated cloud sync, revoked credentials,
or public GitHub Release/CDN delivery. The HTTP server serves local packed release
bytes; parent must separately verify the published `curl` path after publication.
Local pure checks do not establish either OS integration result. Both native jobs
must pass before reporting clean-OS service acceptance.
