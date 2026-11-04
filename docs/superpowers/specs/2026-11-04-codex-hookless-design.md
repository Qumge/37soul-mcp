# Codex without user-managed hooks

User authorization: research competing open-source integrations, implement a viable alternative, remove this machine's 37Soul Codex hooks and retest. Native implementation selected by the agent under that authorization.

## Evidence and decision
- claude-mem ships Codex hooks and a local transcript watcher; issue 3771 documents the same trust barrier: https://github.com/thedotmack/claude-mem/issues/3771 . Watcher: https://github.com/thedotmack/claude-mem/blob/main/src/services/transcripts/watcher.ts
- Mem0 distinguishes full lifecycle-hook integration from MCP-only tools: https://github.com/mem0ai/mem0/blob/main/docs/integrations/codex.mdx . MCP reference memory uses explicit CRUD tools and instructions: https://github.com/modelcontextprotocol/servers/tree/main/src/memory . MCP Memory Service also advertises native Codex lifecycle hooks: https://github.com/doobidoo/mcp-memory-service/blob/main/docs/integrations.md .
- Codex requires trust for both plugin and global hooks: https://learn.chatgpt.com/docs/hooks . Never edit native trust or masquerade as admin-managed hooks.
- This machine exposes CODEX_THREAD_ID to command tools, matching the exact native session context. The exact rollout header contains session_meta.payload.id. Its event_msg records include task_started/task_complete with turn_id; neither mtime nor cwd establishes identity.

## Behavior
Codex connect accepts a target alone and resolves CODEX_THREAD_ID in the executing host environment. Explicit native flags remain compatible; conflicting flags fail before HTTP or consent changes. Find only the exact filename ID under the native sessions directory, validate its header and regular-file identity, reject ambiguous matches and symlinks. Keep other host adapters unchanged.

After explicit connection, only that binding's original local transcript is observed. Queue completed, matching native task_started/task_complete turns after the attach byte boundary. Never infer completion from silence. Freeze the exact byte window and digest, retain the original binding and reuse scheduler limits. Interrupted, replaced, truncated, oversized, pre-attach and revoked/detached sources do not become memory. Observers run in agentd, not foreground tools; unchanged files require metadata only. No raw upload and no per-tool process.

Install migrates only 37Soul-owned Codex handlers away, preserving other handlers, group fields and top-level settings. Back up the original config before migration. Do not disable global hooks or alter trust hashes. Skills and website instructions route Codex through the runtime instead of demanding hook context.

Without native before-request injection, restoring identity after compaction relies on the Agent following installed instructions and the local context command. Do not claim guaranteed model adoption or automatic recall on every prompt. Existing sessions must explicitly connect; no cross-session default Soul is introduced.

## Acceptance
Offline native-shaped fixtures cover target resolution, multi-session/Soul isolation, completion/interrupt, torn JSONL, restart dedupe, source mutation, revocation, hook migration and scheduler invocation with an injected model. Actual native environment and rollout metadata are inspected read-only. No paid native-model evaluation is authorized in this change; distinguish offline model stub from real model acceptance.
