# Runtime health readiness correction (0.15.3 candidate)

Base: main 70fa0229e483b00497b7e2e715295c37d6004b73. Isolated branch: fix/runtime-health-readiness.

Confirmed P2: the service remains active while sync_once awaits network I/O, but all IPC dispatch shared its mutation FIFO. inspectRuntime's existing 500ms health deadline could expire during a healthy startup sync. Independent Sagan offline evidence: idle health 2ms, blocked health 501ms timeout, after release 1ms, same process, zero network attempts. Evidence: /private/tmp/writer-health-fifo-review-vxtk1pum/review-report.json.

Minimal correction: after the unchanged frame/whitelist validation, only fixed built-in process metadata health bypasses the FIFO. It does not dispatch a registry override or read snapshot, profile, credential, model or network data. All ordinary commands, including status, remain serialized. Health fields and the 500ms production deadline are unchanged.

Strict TDD: five new tests initially 3 pass / 2 fail (blocked health deadline and arbitrary registry override). Implementation yields 5/5; focused store/writer/readiness/sync coverage 55/55. Tests verify 150ms health response while a controlled mutation remains blocked, ordinary cross-command FIFO, status queuing, malformed/oversized frame rejection, and metadata-only access. Raw test transport has bounded connect/response deadlines and end/close handling; no production socket changes were made for test cleanup.

Full source npm test before version bump: 786 total / 784 pass / 0 fail / 2 skip (no local Node 18 and no packed tree), plus 64/64 smoke checks; build and bundle passed. Fresh 0.15.3 actual pack and required packed-release full suite follow the source commit; final hashes/counts are in the external provenance handoff.

No live service operation, native/model call, credential change, merge, push or publication was performed. Candidate awaits parent review and release. This liveness response proves a responsive process, not completed synchronization.
