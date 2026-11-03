# Gemini CLI and Cursor native hosts

Runtime host order is canonical in `src/hosts/registry.ts`: Claude Code, Codex,
OpenCode, Hermes, Pi, Gemini CLI, Cursor. The protocol has seven runtime kinds.
Both new hosts are partial integrations: identity/context hooks and native-payload parsing only. They must not be advertised as full Agent support or local memory growth.
**Neither new host currently supports automatic model extraction.** They never
fall back to another CLI, a direct provider API, or a cloud model.

## Native protocol

| Host | User configuration | Native event | Runtime command flag |
| --- | --- | --- | --- |
| Gemini CLI | `~/.gemini/settings.json` | `SessionStart` | `--event SessionStart` |
| Gemini CLI | same | `BeforeAgent` | `--event UserPromptSubmit` |
| Gemini CLI | same | `AfterAgent` | `--event Stop` |
| Gemini CLI | same | `PreCompress` | `--event PreCompact` |
| Cursor | `~/.cursor/hooks.json`, version 1 | `sessionStart` | `--event SessionStart` |
| Cursor | same | `beforeSubmitPrompt` | `--event UserPromptSubmit` |
| Cursor | same | `stop` | `--event Stop` |
| Cursor | same | `preCompact` | `--event PreCompact` |

Gemini hooks use event arrays containing `{hooks:[{type:"command",…}]}`.
Cursor hooks use event arrays containing `{type:"command",command:…}` directly.
Gemini timeouts are milliseconds (5000); Cursor timeouts are seconds (5).
Commands invoke the fixed runtime launcher, or the provided Node/CLI paths, with
POSIX shell quoting. There is no native model call in installation.

Gemini uses `session_id`, `cwd`, `prompt`, and the supplied `transcript_path`.
Cursor uses `conversation_id` (or `session_id`), `workspace_roots[0]`/`cwd`,
`prompt`, `transcript_path`, and the completed stop's `generation_id`.
Cursor conversation_id takes precedence over session_id; their equality is not
enforced. Empty/non-string identities and stop statuses other than `completed`
do not produce a valid completed-session identity.
`user_email`, assistant response bodies, and tool payloads are not returned by
the parser. Missing transcript paths remain null; no path is guessed from cwd.

Cursor's generation ID is local completion provenance, **not a claim that the
transcript contains an equivalent record ID**. Gemini's completed-turn helper
recognizes legacy JSON `messages[].id` and simple message JSONL, and rejects
patched, rewound, torn, or incomplete formats. These are synthetic protocol
fixtures informed by the official implementation, not live-runtime acceptance.
Gemini's mutable JSON recording must not be assumed to be an append-only log.

## Injection contract for the connection-repair parent

`HostHookSpec.formatContext?(text, canonicalEvent)` returns the complete native
JSON response string. Existing hosts can keep their default response formatter.
The parent must append its connection hint to the **text before formatting**,
then emit this native response:

- Gemini `UserPromptSubmit` ->
  `{"hookSpecificOutput":{"hookEventName":"BeforeAgent","additionalContext":"…"}}`.
  This is Gemini's configured injection channel, executed before each request.
  Its `SessionStart` formatter uses `hookEventName: "SessionStart"` if needed.
- Cursor `SessionStart` -> `{"additional_context":"…"}`. Cursor does not consume
  Claude's `hookSpecificOutput.additionalContext` envelope. Cursor sessionStart
  runs as fire-and-forget, so output is not proof the host/model consumed it.
- Cursor `beforeSubmitPrompt` has no documented context-injection field. Its
  formatter returns `{}` at this point. The parent must gate injection and
  injection receipts on `event === host.hook.injectionChannel`; request-event
  emission can still happen.

`HostHookPayload.sourceTurnRefs?: string[]` supplies Cursor's completed
`[generation_id]`. At canonical Stop the parent should start with this value and
only fall back to `host.hook.completedTurnRefs(transcript)` when it is absent.
The parent must still capture the supplied path and a bounded source endpoint
when refs came from the payload. Keep path and completion IDs in the existing
local RuntimeEvent/source-index flow; never upload transcript content. An absent
or incompatible source cannot become successful extraction.

Additional parent-owned integration:

- Remove Gemini's stale `KNOWN_UNSUPPORTED` hint from `src/install.ts`.
  Detection and install planning already derive support from the registry.
- Update older five-host count assertions and website/server runtime whitelists.
- Update both READMEs and the web install script's host comment. Do not equate
  hook configuration with complete extraction support or verified host loading.

## Configuration ownership

Installation creates no instructions file or remote MCP registration. It
preserves all other settings, other vendors' hooks, disabled hook preferences,
and user hooks sharing a Gemini hook group. Every managed command ends with
`# 37soul-managed:<kind>:<native-event>:v1`; uninstall requires the matching
command type, canonical invocation and full marker. Unmarked commands survive.

Identical reinstall does not rewrite the configuration or create another
backup. Changed configuration uses the repository's timestamped backup editor.
Malformed JSON, incompatible root/hooks shapes, and unknown Cursor config
versions are rejected before a write or backup. Uninstall preserves unreadable
or incompatible configuration and reports that it kept the file.

Doctor checks every expected event against the current launcher and separately
reports runtime observations for the active profile/device. Gemini
`hooksConfig.enabled: false` or disabled managed hook names/commands remain
untouched and are reported as disabled. Installation always reports:

```json
{"installed":true,"trusted":false,"events_seen":false,"extraction_capable":false,"injection_capable":false}
```

A native hook-output receipt can confirm local output, not host trust/loading or
model adoption. Doctor never writes configuration, launches a model, or treats
our config write as runtime evidence.

## Extraction blocker and bounded validation

The canonical native invokers are **`gemini`** and **`cursor-agent`**. The generic
`agent` executable is never considered a Cursor candidate.

Gemini's documented headless shape is `gemini -p … --output-format json`, whose
result envelope contains `response`, `stats`, and optionally `error`.
`--allowed-tools` bypasses confirmation; it does not disable tools. The suggested
per-job deny-all policy and system settings override were investigated against
the official implementation on 2026-11-03:

1. `toolName="*"` covers built-in and MCP tools, but a file supplied by `--policy`
   is assigned User tier (4). Even priority 999 produces 4.999; an Admin allow
   rule has priority >=5. The highest matching rule wins. A temporary file alone
   cannot guarantee denial in the presence of system policy.
2. `--admin-policy` is not an unconditional workaround. `createPolicyEngineConfig`
   explicitly ignores supplemental admin policy paths when the system policy
   directory already contains any `.toml` policy.
3. `GEMINI_CLI_SYSTEM_SETTINGS_PATH` redirects only the settings file.
   `Storage.getSystemPoliciesDir()` independently resolves the system config
   directory's `policies` subdirectory. The system settings override therefore
   does not isolate or neutralize the higher-tier policies above.
4. System settings can disable ordinary hooks, but MCP startup/required servers
   also depend on remote admin settings. `LoadedSettings.computeMergedSettings`
   ignores file-based admin settings in favor of remote controls. A settings file
   containing `admin.mcp.enabled:false` is not a reliable isolation mechanism.

These are configuration counterexamples, not an assertion that safe extraction
is impossible in every Gemini deployment. A future guarded implementation must
verify a supported binary/version, establish effective policy/config isolation
including admin and startup behavior, and fail closed when that cannot be
proved. This machine has no Gemini binary for bounded feature verification.
The current NativeInvoker cannot pass job-specific environment/cwd options;
changing the parent process environment would race other jobs and is not used.
The adapter therefore returns `gemini_cli_tool_free_extraction_unverified` with
`retryable:false` after resolving a nonempty local source and before invoking any CLI.
An empty source retains the shared `source_unavailable`, `retryable:true` contract. No unused policy
file is created and presented as working extraction.

Official implementation evidence (read-only inspection, no model execution):

- [Flag parsing and effective policy paths](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts#L335-L350)
- [Policy directory precedence and admin override guard](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/policy/config.ts#L264-L330)
- [Settings override versus system policy directory](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/storage.ts#L171-L180)
- [Policy priority sorting and first matching decision](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/policy/policy-engine.ts#L239-L242)
- [Remote admin settings override file-based admin values](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/settings.ts#L397-L410)

Cursor's headless shape would be `cursor-agent --print --output-format json`.
Its official parameter reference and this machine's help explicitly say print
mode has access to write/shell tools. No verified per-call option disables all
tools and MCP servers. Omitting `--force` or using ask/plan mode does not prove
that tools are disabled. The adapter returns
`cursor_tool_free_extraction_unavailable` with `retryable:false`, after resolving
a nonempty local source and before invocation. Empty source instead returns
`source_unavailable` with `retryable:true`. It does not silently return successful empty proposals.

Both probes retain `0.0.0-unverified` and false capability flags; config writes
do not change them. Adapter injection returns delivered:false/unverified; the
native hook stdout path is the implemented injection surface.

On 2026-11-03 this machine was checked with bounded commands only:

- `cursor-agent --version`: `2025.09.12-4852336`.
- `cursor-agent --help`: print supports `text|json|stream-json`; write/bash tools
  remain available. This old CLI's help does not advertise current hook support.
- `command -v gemini`: not found. No installation attempted.

No real host session, hook load/trust, native context adoption, or model
extraction was exercised. No paid model call, user configuration change,
push/merge/release, or raw transcript upload was performed.

## Official sources

- [Gemini hook reference](https://geminicli.com/docs/hooks/reference/)
- [Writing Gemini hooks](https://geminicli.com/docs/hooks/writing-hooks/)
- [Gemini configuration and command-line arguments](https://geminicli.com/docs/reference/configuration/)
- [Gemini headless JSON output](https://geminicli.com/docs/cli/headless/)
- [Gemini policy tiers and tool restrictions](https://geminicli.com/docs/reference/policy-engine/)
- [Gemini native recording implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts)
- [Cursor native hooks](https://cursor.com/docs/hooks)
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- [Cursor headless CLI](https://cursor.com/docs/cli/headless)

## Offline verification

The new host tests cover 30 cases: 26 host/config/adapter cases and four real
local-writer integration cases. They pass with zero skips. The combined focused
registry/install/hook/native-invoker/source-output regression run passes 129/129.
TypeScript build and bundled runtime build also pass. The original host tests
were observed red before implementation (0/21); the later empty-source contract
change was observed red before its implementation (22/26, four failures).

The integration drain does not invent successful growth: Gemini's synthetic
JSONL source resolves and records `gemini_cli_tool_free_extraction_unverified`;
Cursor's generation ID has no assumed transcript-record mapping and records
`source_unavailable`. Both remain incomplete/error, with zero completed model
extractions. Separate nonempty-source seam tests verify Cursor's explicit tool
safety blocker. This is offline evidence, not live host/model acceptance.
