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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Where 37soul writes its own hook subscription record (the "installed" state). */
export function codexHookConfigPath(home: string): string {
  return path.join(home, ".codex", "37soul-hooks.json");
}

/** Codex's own config (the only place a trust marker may live). */
export function codexConfigPath(home: string): string {
  return path.join(home, ".codex", "config.toml");
}

/** Distinct from `codex mcp add 37soul` (which writes `[mcp_servers.37soul]`), so
 *  our own MCP registration can never be mistaken for a Codex-authored trust marker. */
const CODEX_TRUST_SECTION = "hooks.37soul-hooks";

/**
 * Extract the `[hooks.37soul-hooks]` TOML section only. Trust must be section-scoped:
 * a `trusted = true` under an unrelated section — or inside a comment — never counts.
 */
function readCodexHooksSection(text: string): string {
  // Section headers: [hooks.37soul-hooks] or the quoted [hooks."37soul-hooks"] form.
  const header = /^\s*\[\s*hooks\s*\.\s*(?:"?37soul-hooks"?|'37soul-hooks')\s*\]\s*(?:#.*)?$/;
  const lines = text.split("\n");
  let inSection = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (!inSection) {
      if (header.test(line)) inSection = true;
      continue;
    }
    if (/^\s*\[/.test(line)) break; // the next section ends ours
    collected.push(line);
  }
  return collected.join("\n");
}

export interface CodexTrustState {
  trusted: boolean;
  events_seen: boolean;
  reason: "trusted" | "pending";
}

/**
 * Read Codex's own config and report trust only from a Codex-authored marker in the
 * `[hooks.37soul-hooks]` section. UNVERIFIED marker path: the real trust store
 * format is not confirmed by an authorized live probe. Anything else — including a
 * config write we performed — stays pending.
 *
 * `events_seen` is independently derived and honest: there is no event-observation
 * mechanism yet, so a trust marker ("Codex may run the hook") can never report that
 * events were seen. It stays false regardless of the trust marker until an
 * observation path exists.
 */
export function inspectCodexTrust(home: string): CodexTrustState {
  let text = "";
  try {
    text = readFileSync(codexConfigPath(home), "utf8");
  } catch {
    // no config.toml yet: nothing Codex wrote, so nothing is trusted
  }
  const section = readCodexHooksSection(text);
  const trusted = /^\s*trusted\s*=\s*true\s*(?:#.*)?$/m.test(section);
  return trusted
    ? { trusted: true, events_seen: false, reason: "trusted" }
    : { trusted: false, events_seen: false, reason: "pending" };
}

/**
 * Record the hook events 37soul installs. This is the "installed" state only —
 * a config write we ourselves performed. It never claims Codex executes the hooks.
 */
export function writeCodexHookConfig(
  home: string,
  opts: { now?: () => number } = {},
): { installed: boolean; path: string } {
  const file = codexHookConfigPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    managed_by: "37soul",
    note:
      "Codex hook config format is UNVERIFIED (no authorized live probe). This file records the " +
      "events 37soul subscribes to; it does not claim Codex executes them.",
    installed_at: new Date(opts.now?.() ?? Date.now()).toISOString(),
    verified: false,
    events: CODEX_HOOK_EVENTS.map((entry) => entry.event),
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { installed: true, path: file };
}

/** Remove the managed hook config; returns false when there is nothing to remove. */
export function removeCodexHookConfig(home: string): boolean {
  const file = codexHookConfigPath(home);
  if (!existsSync(file)) return false;
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
export function codexCompletedTurnRefs(jsonl: string): { session_id: string | null; refs: string[] } {
  const sessionId = codexNativeSessionId(jsonl);
  const refs: string[] = [];
  let turnStarted = false;
  for (const record of parseJsonl(jsonl)) {
    if (record.type === "turn_context") {
      if (turnStarted) break; // the next turn begins: the first turn is complete
      turnStarted = true;
      continue;
    }
    if (record.type === "response_item") {
      turnStarted = true;
      if (typeof record.ordinal === "number") refs.push(String(record.ordinal));
    }
  }
  return { session_id: sessionId, refs };
}

/**
 * The bounded raw text of one completed turn, reusing the shared Codex rollout
 * parser (no second rollout parser). `refs` are the ordinals from
 * `codexCompletedTurnRefs`; a real `readSource` renders exactly those records.
 */
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
      if (typeof event.text === "string" && event.text.trim() !== "") lines.push(event.text);
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
  return { args: ["exec", "--output-format", "json"], input };
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
      const { refs } = codexCompletedTurnRefs(transcript);
      if (refs.length === 0) return { proposals: [] };
      // 3. Re-read exactly the completed turn's source through the same seam.
      const turnText = await deps.readSource(refs);
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
