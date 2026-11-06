# Gemini CLI, Cursor and Kiro native hosts

Runtime host order is canonical in `src/hosts/registry.ts`: Claude Code, Codex,
OpenCode, Hermes, Pi, Gemini CLI, Cursor, Kiro. The protocol has eight runtime kinds.
The three newer hosts are partial integrations: identity/context hooks and native-payload parsing only. They must not be advertised as full Agent support or local memory growth.
**None of the three currently supports automatic model extraction.** They never
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
| Kiro | `~/.kiro/hooks/37soul.json`, version `v1` | `SessionStart` | `--event SessionStart` |
| Kiro | same | `UserPromptSubmit` | `--event UserPromptSubmit` |

Gemini hooks use event arrays containing `{hooks:[{type:"command",…}]}`.
Cursor hooks use event arrays containing `{type:"command",command:…}` directly.
Kiro hooks use a root object whose `hooks` array contains
`{name,trigger,action:{type:"command",command},timeout,enabled}`, with PascalCase
triggers. Gemini timeouts are milliseconds (5000); Cursor timeouts are seconds (5);
Kiro timeouts are seconds (30). Commands invoke the fixed runtime launcher, or the
provided Node/CLI paths, with POSIX shell quoting. There is no native model call in
installation.

Gemini uses `session_id`, `cwd`, `prompt`, and the supplied `transcript_path`.
Cursor uses `conversation_id` (or `session_id`), `workspace_roots[0]`/`cwd`,
`prompt`, `transcript_path`, and the completed stop's `generation_id`.
Kiro uses `session_id`, `cwd`, and `prompt` (or `user_prompt`); its hook payload
has no documented `transcript_path`, so the parser returns null rather than
guessing one.
Cursor conversation_id takes precedence over session_id; their equality is not
enforced. Empty/non-string identities and stop statuses other than `completed`
do not produce a valid completed-session identity.
`user_email`, assistant response bodies, and tool payloads are not returned by
the parser. Missing transcript paths remain null; no path is guessed from cwd.

Kiro is an **identity/context host**: `HostHookSpec.sourceBoundary` is
`"optional"`. An explicit `37soul connect --host <id> --agent kiro --session
<sess_…>` may bind a chosen Soul from an existing native session without a byte
boundary, and a repeated connect is idempotent while no boundary exists. The
binding therefore carries no `source_boundary`, and automatic extraction stays
blocked by the adapter (`kiro_tool_free_extraction_unavailable`). Hosts whose
spec leaves `sourceBoundary` unset keep the existing rule: a connect without a
valid hook source pointer fails with `session_context_unavailable`. A connect
never invents a native session ID; the value must come from the host context or
local session records.

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
- Kiro `SessionStart` -> plain text. For CLI V3, Kiro adds `SessionStart` stdout
  to the session context directly; it does not use Claude's
  `hookSpecificOutput` envelope. Kiro's `UserPromptSubmit` is installed so the
  session and prompt events are observed, but the parent emits no stdout there
  because the injection channel is `SessionStart`.

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

The canonical native invokers are **`gemini`**, **`cursor-agent`** and **`kiro-cli`**.
The generic `agent` executable is never considered a Cursor candidate.

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

Kiro's standalone hooks are file-based; the installed CLI has no `hook`
subcommand, so hook installation does not make a later `kiro-cli` job tool-free.
Its interactive and headless invocations expose shell and MCP tools, and no
verified non-interactive option disables all of them for one job. The adapter
therefore returns `kiro_tool_free_extraction_unavailable` with `retryable:false`,
after resolving a nonempty local source and before invoking the CLI. Empty source
returns `source_unavailable` with `retryable:true`.

All three probes retain `0.0.0-unverified` and false capability flags; config writes
do not change them. Adapter injection returns delivered:false/unverified; the
native hook stdout path is the implemented injection surface.

On 2026-11-03 this machine was checked with bounded commands only:

- `cursor-agent --version`: `2025.09.12-4852336`.
- `cursor-agent --help`: print supports `text|json|stream-json`; write/bash tools
  remain available. This old CLI's help does not advertise current hook support.
- `command -v gemini`: not found. No installation attempted.
- `kiro-cli --version`: `3.1.0`. Its help has no `hook` subcommand; hooks are the
  standalone files under `~/.kiro/hooks/`.

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
- [Kiro CLI hooks](https://kiro.dev/docs/cli/v3/hooks/)
- [Kiro hook migration reference](https://kiro.dev/docs/cli/v3/hooks-migration/)
- [Kiro hooks overview](https://kiro.dev/docs/cli/hooks/)

## Offline verification

The new host tests cover 46 cases: 41 host/config/adapter cases and five real
local-writer integration cases. Kiro's share covers config preservation and
uninstall, doctor states, native-payload parsing, plain-text `SessionStart`
injection, and the tool-free extraction blocker. A separate account-first CLI
case covers identity-only connect from an existing `sess_…` native session
without a transcript path. They pass with zero skips.
TypeScript build and bundled runtime build also pass. The original Gemini/Cursor
host tests were observed red before implementation (0/21); the later empty-source
contract change was observed red before its implementation (22/26, four failures).

The integration drain does not invent successful growth: Gemini's synthetic
JSONL source resolves and records `gemini_cli_tool_free_extraction_unverified`;
Cursor's generation ID has no assumed transcript-record mapping and records
`source_unavailable`. Kiro registers no `Stop` event, so its live-hook fixture
schedules no extraction watermark at all; a separate nonempty-source seam test
verifies its explicit tool-safety blocker. All paths remain incomplete/error,
with zero completed model extractions. Separate nonempty-source seam tests also
verify Cursor's explicit tool safety blocker. This is offline evidence, not live
host/model acceptance.

Post-review verification also covers preserving a renamed or unnamed disabled Gemini
hook across launcher upgrades, and matching disabled identities using Gemini's exact
`name || command` rule. Both regressions failed before the fix in `08351cc` and pass
after it. The final full suite on this tree has 984 tests: 983 pass, 0 fail, and one
local Node 18 availability skip; the MCP smoke checks pass.
