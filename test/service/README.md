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
  -f service_acceptance=true -f baseline_ref=632f606
gh run list --workflow release-runtime.yml
gh run watch <run-id> --exit-status
gh run download <run-id> --dir service-results
```

This extends the existing registered release workflow: parent can dispatch the
combined branch with `--ref` without first merging product changes to main.
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

1. Candidate fresh default **no-argument** HTTP installer and checksum download.
2. Candidate repeated default install replaces the running PID.
3. Uninstall retaining actual anonymous profile files and synthetic spool/queue data.
4. Baseline default install followed by candidate default upgrade; old PID exits.
5. Real manager restart, new PID, healthy writer, data unchanged.
6. Final uninstall: service disabled/unregistered, PID gone, launcher/runtime/socket
   removed, profiles and archives retained byte for byte.

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

Limits: manager restart is tested, **not VM reboot/login persistence**. This does
not test host hooks/model extraction, authenticated cloud sync, revoked credentials,
or public GitHub Release/CDN delivery. The HTTP server serves local packed release
bytes; parent must separately verify the published `curl` path after publication.
Local pure checks do not establish either OS integration result. Both native jobs
must pass before reporting clean-OS service acceptance.
