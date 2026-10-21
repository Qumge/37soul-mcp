/**
 * Task 7: the Codex runtime adapter.
 *
 * Honesty contract (replaces the old "hook:false means fine" B-tier assumption):
 *   - Codex hooks require trust before they execute, and this task has no
 *     authorized live probe. `probe()` therefore reports only observed capability:
 *     version "0.0.0-unverified", `structured_extraction: false`, and every
 *     hook-derived capability false.
 *   - `CODEX_HOOK_EVENTS` models the subscription surface implied by the existing
 *     install wiring (INJECTION_CHANNEL / RUNTIME_EVENT_KINDS in hook.ts) and the
 *     rollout data. Every event name is UNVERIFIED against the real Codex CLI.
 *   - `writeCodexHookConfig` records the subscription 37soul installs — the
 *     "installed" state. It is a config write WE performed, so it never makes
 *     "trusted" or "events_seen" green.
 *   - `inspectCodexTrust` reads only Codex's own config and returns `trusted` only
 *     from a section-scoped Codex-authored trust marker in `[hooks.37soul-hooks]`;
 *     `events_seen` is independently derived and stays false — there is no
 *     event-observation mechanism, so a trust marker never reports events as seen.
 *     The exact marker path is UNVERIFIED.
 *   - `extract()` runs the native model ONLY through `deps.invoke` (never a raw
 *     spawn) and reuses the shared Codex rollout parser for session identity and
 *     turn text. `buildCodexExtractionInvocation` is the single exported command
 *     builder; its args are UNVERIFIED and no supported version is registered, so
 *     the P0 matrix row for Codex stays 未验.
 *
 * Session identity: a rollout's native session id is read from
 * `session_meta.payload.id` (see `codexNativeSessionId` in parsers/codex.ts) — a
 * rollout file path or directory never proves session inheritance. `extract()`
 * uses the native session id already pinned in the request; it never consults a
 * process-global like SOUL37_HOST_ID.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ParsedEvent } from "../agentd/types.js";
import { codexNativeSessionId, createCodexParser } from "../agentd/parsers/codex.js";
import type { ContextBundle } from "../assets/protocol.js";
import { buildExtractionInvocation, parseExtractionOutput } from "./claude-code.js";
import type {
  AdapterDeps,
  ExtractionRequest,
  ExtractionResult,
  InjectionResult,
  RuntimeAdapter,
  RuntimeProbe,
} from "./types.js";

/** The Codex lifecycle events the installer would subscribe to (single source of
 *  truth). UNVERIFIED: no authorized live probe has confirmed Codex actually fires
 *  these — the names mirror the existing install wiring and the rollout data. */
export const CODEX_HOOK_EVENTS: ReadonlyArray<{ event: string; verified: boolean }> = [
  { event: "SessionStart", verified: false },
  { event: "UserPromptSubmit", verified: false },
  { event: "Stop", verified: false },
  { event: "PreCompact", verified: false },
  { event: "SessionEnd", verified: false },
];

/** Official Codex hook file (hooks.json next to the active config layer). */
export function codexHookConfigPath(home: string): string {
  return path.join(home, ".codex", "hooks.json");
}

export interface CodexTrustState {
  trusted: boolean;
  events_seen: boolean;
  reason: "pending" | "observed";
}

/**
 * Codex trusts hooks by exact definition hash and records that decision in its own
 * (currently undocumented) trust store. We never fabricate a trust marker: this
 * reports `trusted:false` until Codex itself shows the hook as trusted. `events_seen`
 * is independent evidence from our local hook spool, never from a config write.
 */
export function inspectCodexTrust(home: string): CodexTrustState {
  let eventsSeen = false;
  try {
    const dir = path.join(home, ".37soul", "spool", "codex");
    eventsSeen = readdirSync(dir).some((name) => name.endsWith(".jsonl"));
  } catch {
    // no spool yet
  }
  return eventsSeen
    ? { trusted: false, events_seen: true, reason: "observed" }
    : { trusted: false, events_seen: false, reason: "pending" };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write the official hooks.json shape. Existing vendor hooks are preserved; only
 * groups containing our `hook --agent codex` command are replaced. This file is
 * not proof of trust or execution.
 */
export function writeCodexHookConfig(
  home: string,
  opts: { now?: () => number; command?: string } = {},
): { installed: boolean; path: string } {
  const file = codexHookConfigPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  let document: Record<string, any> = {};
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) document = parsed;
  } catch {
    // absent or malformed: replace with a valid managed document
  }
  if (existing !== "") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    writeFileSync(`${file}.37soul-${stamp}.bak`, existing, { mode: 0o600 });
  }
  const launcher = opts.command ?? "37soul";
  const hooks = document.hooks && typeof document.hooks === "object" && !Array.isArray(document.hooks)
    ? document.hooks as Record<string, any>
    : {};
  const entries: Array<[string, string | null]> = [
    ["SessionStart", "startup|resume|clear|compact|fork"],
    ["UserPromptSubmit", null],
    ["PreCompact", "manual|auto"],
    ["Stop", null],
    ["SessionEnd", null],
  ];
  for (const [event, matcher] of entries) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const preserved = groups.filter((group: any) =>
      !(Array.isArray(group?.hooks) && group.hooks.some((handler: any) =>
        typeof handler?.command === "string" && handler.command.includes("hook --agent codex"),
      )),
    );
    const group: Record<string, any> = {
      hooks: [{
        type: "command",
        command: `${shellQuote(launcher)} hook --agent codex --event ${event}`,
        timeout: 5,
      }],
    };
    if (matcher) group.matcher = matcher;
    preserved.push(group);
    hooks[event] = preserved;
  }
  document.hooks = hooks;
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return { installed: true, path: file };
}

/** Remove only our handlers; preserve every other vendor hook in hooks.json. */
export function removeCodexHookConfig(home: string): boolean {
  const file = codexHookConfigPath(home);
  if (!existsSync(file)) return false;
  try {
    const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    if (document && typeof document.hooks === "object" && !Array.isArray(document.hooks)) {
      let remaining = 0;
      for (const [event, groups] of Object.entries(document.hooks as Record<string, any>)) {
        if (!Array.isArray(groups)) continue;
        const kept = groups.filter((group: any) =>
          !(Array.isArray(group?.hooks) && group.hooks.some((handler: any) =>
            typeof handler?.command === "string" && handler.command.includes("hook --agent codex"),
          )),
        );
        if (kept.length > 0) { (document.hooks as Record<string, any>)[event] = kept; remaining += kept.length; }
        else delete (document.hooks as Record<string, any>)[event];
      }
      if (remaining === 0 && Object.keys(document.hooks).length === 0) {
        rmSync(file, { force: true });
      } else {
        writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      }
      return true;
    }
  } catch {
    // malformed file: leave it untouched rather than deleting user data
    return false;
  }
  rmSync(file, { force: true });
  return true;
}

function parseJsonl(jsonl: string): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, any>);
      }
    } catch {
      // A torn line is skipped locally, never fatal.
    }
  }
  return records;
}

/**
 * The first completed turn's record refs plus the rollout's native session id.
 * Walk records from the first `turn_context`, collecting the ordinals of every
 * `response_item` until the NEXT `turn_context` — the first turn is exactly the
 * completed turn, and no later turn, meta record or compaction record leaks in.
 * The session id comes from the rollout itself (session_meta.payload.id), never
 * from the file path or a process-global.
 */
export function codexCompletedTurnRefs(jsonl: string, latest = false): { session_id: string | null; refs: string[] } {
  const sessionId = codexNativeSessionId(jsonl);
  const refs: string[] = [];
  let turnStarted = false;
  for (const record of parseJsonl(jsonl)) {
    if (record.type === "turn_context") {
      if (latest) {
        refs.length = 0; // the latest turn replaces the refs from earlier turns
        turnStarted = true;
        continue;
      }
      if (turnStarted) break; // the next turn begins: the first turn is complete
      turnStarted = true;
      continue;
    }
    if (!turnStarted) continue; // developer/setup messages before turn_context
    if (record.type === "response_item" && typeof record.ordinal === "number") {
      refs.push(String(record.ordinal));
    }
  }
  return { session_id: sessionId, refs };
}

/**
 * The bounded raw text of one completed turn, reusing the shared Codex rollout
 * parser (no second rollout parser). `refs` are the ordinals from
 * `codexCompletedTurnRefs`; a real `readSource` renders exactly those records.
 */
export function latestCodexCompletedTurnRefs(jsonl: string): { session_id: string | null; refs: string[] } {
  return codexCompletedTurnRefs(jsonl, true);
}

export function renderCodexTurn(jsonl: string, refs: readonly string[]): string {
  const wanted = new Set(refs);
  const records = parseJsonl(jsonl).filter(
    (record) => typeof record.ordinal === "number" && wanted.has(String(record.ordinal)),
  );
  const parser = createCodexParser();
  const events: ParsedEvent[] = [];
  for (const record of records) events.push(...parser.push(record));
  events.push(...parser.flush());

  const lines: string[] = [];
  for (const event of events) {
    if (event.role === "user" || event.role === "assistant") {
      if (typeof event.text === "string" && event.text.trim() !== "") {
        lines.push(`${event.role === "user" ? "User" : "Assistant"}: ${event.text}`);
      }
    } else if (event.role === "tool") {
      const name = event.tool?.name ?? "tool";
      const summary = [event.tool?.input_summary, event.tool?.output_summary]
        .filter((part) => typeof part === "string" && part.trim() !== "")
        .join(" => ");
      lines.push(summary ? `[tool:${name} ${summary}]` : `[tool:${name}]`);
    }
  }
  return lines.join("\n");
}

/**
 * The native invocation for extraction, isolated in one exported builder so the
 * "invoked only via deps.invoke" invariant stays auditable. UNVERIFIED: no
 * authorized live probe has confirmed Codex's non-interactive structured-output
 * invocation, so the P0 matrix row stays 未验 and no supported version is
 * registered from this surface. The prompt is shared with the Claude adapter.
 */
export function buildCodexExtractionInvocation(
  request: ExtractionRequest,
  turnText: string,
): { args: readonly string[]; input: string } {
  const { input } = buildExtractionInvocation(request, turnText);
  // Codex's non-interactive surface is `codex exec --json` (JSONL events), not
  // `--output-format`. Read-only + skip-git-repo-check keeps this a text task and
  // works from agentd's non-repository cwd; the prompt is piped on stdin.
  return { args: ["exec", "--json", "--skip-git-repo-check", "-s", "read-only"], input };
}

export function createCodexAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "codex",

    async probe(): Promise<RuntimeProbe> {
      // Only observed capability. Codex hooks require trust and there is no
      // authorized live probe, so nothing hook-derived is reported as available.
      return {
        runtime_kind: "codex",
        version: "0.0.0-unverified",
        session_id: false,
        before_request: false,
        structured_extraction: false,
        internal_marker: false,
        resume: false,
        compact: false,
        interrupt: false,
      };
    },

    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      // 1. Read the raw rollout through the ONLY raw-source seam.
      const transcript = await deps.readSource(request.source_event_refs);
      // 2. Resolve the completed turn's concrete refs (no later turn / meta record).
      const refs = request.source_turn_refs && request.source_turn_refs.length > 0
        ? request.source_turn_refs.slice()
        : codexCompletedTurnRefs(transcript).refs;
      if (refs.length === 0) return { error: { code: "source_unavailable", retryable: true } };
      // 3. Render exactly the completed turn from the already-read rollout — the
      //    readSource seam is hit once (bounded); the turn is a local subset of it.
      const turnText = renderCodexTurn(transcript, refs);
      // 4. Invoke the native model through deps.invoke, tagged with the job uid.
      const { args, input } = buildCodexExtractionInvocation(request, turnText);
      const result = await deps.invoke("codex", args, input, request.job_uid);
      if (result.code !== 0) return { error: { code: "model_error", retryable: true } };
      return parseExtractionOutput(result.stdout, request, refs);
    },

    async inject(bundle: ContextBundle): Promise<InjectionResult> {
      const rendered_sha256 = createHash("sha256")
        .update(bundle.rendered_text ?? "", "utf8")
        .digest("hex");
      // Codex hooks are unverified and require trust: the adapter cannot claim the
      // context reached a session. The hook delivers it only once trusted.
      return { delivered: false, rendered_sha256, error: "codex_hooks_untrusted" };
    },
  };
}
