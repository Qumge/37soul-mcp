# Local read routing repair acceptance — 2026-11-05

## Cause and repair
Compact connect hid media/social payloads intentionally for size, but did not expose a read route. Skill social queries entered remote operator guidance even though existing-login whoami already returned recent_life/media/circle/thread. Context recovery also omitted the verified Host ID needed for a later read.

Runtime0.17.1 adds target/runtime-validated local read capabilities to connect and context recovery. No extra HTTP request at connect or ordinary conversation. Hint plus local context remains within4096 bytes plus final newline, including a large Unicode identity and eight pinned-memory fixture. Whoami retains existing authorization and full bounded payload; recall stays per Soul/kind. Global managed guidance also directs covered reads locally so existing sessions need no hook/internal setup.

Skill6.14.1 makes local reads first-priority, with an executable intent table. Missing/empty/old/two-post limits stay truthful, viewing public media never triggers paid generation, and workspace/model/context facts are not claimed as recalled Soul assets. A query about another explicit owned Soul does not switch the current persona. Full archives and explicitly authorized remote/write workflows remain separate; no new permission surface was added.

## Verification
- Runtime full npm test:953 tests,951 passed,0 failed,2 skipped (optional local Node18 binary and pre-pack artifact test). All MCP smoke checks passed. Subsequent packed-artifact checks:7 tests,6 passed,0 failed,only local Node18 skip.
- Related CLI/connect/consent regression group50 passed. Final connect/context budget subset21 passed after adding large-Unicode/eight-memory stress.
- Skill Python30 passed; executable-guide CLI/store harness10 passed. The five added cases execute actual documented social/media/circle/relationship/experience commands, inspect real returned CLI data and unchanged local files, and intercept only a synthetic HTTP GET. No operator login/browser/provider/writes are permitted.
- Rails named agent_docs/current_local_soul_guides/local_agent_connect specs46 examples,0 failures.
- Isolated read-only review reported no important/critical findings in core source and Skill routing. No additional paid model/agent behavioral evaluation was run; document/CLI plumbing correctness does not prove every model follows the updated prompt.

## Delivery
Release, public CI and local installation/preservation evidence will be appended after execution. Screenshots and the original Skill Python cache remain outside task commits.
