# Hook responsiveness and scoped recall implementation plan

> For agentic workers: execute scoped tasks with strict RED/GREEN and independent final review.

Goal: keep foreground native hooks responsive when cloud sync or the writer is slow, and make terminal memory queries identify and isolate their Soul.

User requirement: optimize the foreground wait identified in the preceding code inspection; fix touching state/kind badges in the separate Rails worktree; prevent implicit cross-Soul recall. This is a bounded bugfix, not a change to role selection or model routing.

## Constraints
- Runtime work only in this worktree; Rails spacing in its own worktree.
- No real account, credential, user-memory or model calls for tests; isolated synthetic HOME and Unix sockets only.
- Preserve serialized mutations, first-session binding before injection, consent/revocation, receipt-after-delivery and completed-turn boundaries.
- Do not bypass FIFO for stateful commands or change cloud sync semantics.
- No merge, push, release, installation update or production-data mutation in this implementation pass.

## Approach
One monotonic deadline covers hook preparation, runtime-event acknowledgement, context injection and receipt acknowledgement. Context and completed-turn Stop hooks have a 300ms processing budget; lightweight events have 50ms. Socket waits use the remaining budget and close on expiry; expired work must not emit late stdout or begin a new request. Existing events already submitted to the writer can complete in its serialized queue. A stalled writer can defer fresh context; it must not hold the foreground session indefinitely. Node startup and synchronous OS/runtime scheduling remain outside a hard real-time guarantee.

Recall stays local and deterministic. A single local Soul can be selected implicitly. Multiple Souls require --soul UID, --host ID or --name EXACT_NAME; ambiguity prints role metadata only. --all is explicit and labels each hit. Correctly parse option values, query terminator, limits and invalid options. No session guessing, default-setting or model calls.

## Review Focus
- Writer accepts but never responds: hook function and packaged CLI process exit promptly, with sockets closed.
- A queue clears after timeout: no late context output or false injected receipt.
- Healthy first session: writer creates binding before identity/authorized memories reach stdout.
- Multiple/duplicate-name Souls, orphan assets and profile selection: no implicit memory mixing or unknown-Soul leakage.
- Slow sync: mutation FIFO and cloud ownership/consent boundaries remain intact.

## Tasks
1. Parent: add failing test/hook-budget.test.mjs for stalled SessionStart, UserPromptSubmit, Stop and packaged process exit; observe expected assertion failures. Add minimal whole-hook deadline and remaining-budget IPC waits in src/hook.ts. Verify targeted hook/source-capture suites; use src/local/writer.ts only if socket cleanup requires it.
2. Recall worker: RED new test/recall-cli.test.mjs, implement src/cli.ts and optional assets/recall.ts; update command usage and three READMEs, verify new/old recall and cli tests, commit only owned files.
3. Parent: compile/bundle, run npm test, synthetic packaged hook latency scenarios, fresh read-only final review, fix demonstrated substantive findings with TDD, commit parent task and report evidence.

Baseline: test/hook.test.mjs + test/recall.test.mjs = 22 tests, 22 pass, 0 fail (2026-11-04).

## Implementation rulings
- Full runtime run first found 872 tests / 867 pass / 3 fail / 2 skip. No test execution/concurrency options were changed.
- Stop was initially assigned the 50ms lightweight budget. Unlike a notification it freezes bounded transcript source data and acknowledges a durable completion boundary; parallel filesystem pressure caused early exit. Deterministic 80ms acknowledgement regression failed first. Classify Stop with context/completion's 300ms deadline; explicit shorter test budgets still bound the whole hook.
- test/active-profile.test.mjs had a deliberate old-contract assertion that bare recall expands a two-Soul profile. The new user requirement forbids this: add no-disclosure ambiguity assertions, then preserve its original active-profile/no-other-account checks using explicit --soul s1 and still no --profile flag. This updates an intentional behavior contract, not a relaxed assertion.
- Initial parent hook test fixture incorrectly used anonymous account key local instead of anonymous. Its 4 pass/1 fail result was discarded as setup failure, fixture corrected before implementation, then genuine RED was 5 tests/5 failures.
