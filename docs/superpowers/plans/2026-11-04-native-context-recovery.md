# Native-context recovery repair

Approved behavior: diagnose missing hook context, preserve the requested Soul, and explain the actual recovery action rather than asking the user to repeat the selection. No changes to Codex trust decisions, native identity/source checks, authentication, defaults, or healthy connection round trips.

## Scope
Runtime: src/cli.ts, src/hosts/codex.ts, test/native-context-recovery.test.mjs.
Skill: SKILL.md, references/persona-http.md, three READMEs, tests/test_local_agent_contract.py, tests/test_hook_recovery.py.
Implementation in the two repos' .worktrees/native-context-recovery directories. Main checkouts and installed trust/configuration remain unchanged. Existing skill-main __pycache__ stays untouched.

## Design
- Both missing native flags and missing valid source retain a concrete requested Host ID/name in the error and point to a bounded doctor/hook-loading check. Never infer another session or repeat login/OAuth.
- Codex doctor distinguishes missing/outdated configuration from installed-but-unverified execution. For the latter, direct the user to /hooks review, approval if required, and loading; do not infer trust from missing receipts or require a blanket restart.
- Skill recovery is conditional: installation/runtime issue, native trust/load issue, or source still unavailable after host readiness. Preserve the original target; once exact managed context is supplied, resume the same request. If a host requires another normal turn to refresh, “continue” is enough; no repeated Soul-selection instruction or retry loop.
- Healthy exact-name/ID connection remains direct. Do not add routine diagnostics, profile changes, or a new persistent selection feature.

## Tests and execution
1. Write CLI and doctor behavioral regressions and Skill recovery contracts. Run RED; existing safety controls should remain green.
2. Implement the narrow diagnostic/guidance change, then run focused GREEN.
3. Run runtime pack + npm test, all Skill Python contracts and offline native recall harness. Inspect diffs and commit tested work.
4. Record actual counts and boundaries. No paid model evaluations: prior approved allowance is exhausted; offline guidance checks do not prove an LLM will follow the new rule in every case. The user already authorized merge, publish and local installation for this ongoing delivery. After concrete verification, use that existing authority for the repair release; never approve native hooks on the user's behalf.

## Review focus
Never guess native flags; no network/credential/binding mutation on missing source; preserve explicit target; never auto-approve trust; missing runtime evidence is unknown trust/loading, not proof of rejection; normal connection and consent behavior unchanged.
