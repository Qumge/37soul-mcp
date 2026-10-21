/**
 * Task 8: the OpenCode runtime adapter plus its managed plugin bridge.
 *
 * Honesty contract (same as Codex in Task 7, applied to an unverified plugin host):
 *   - There is no authorized live probe (the plan records that OpenCode's version
 *     command failed on the user's machine). `probe()` therefore reports only
 *     observed capability: version "0.0.0-unverified", `structured_extraction:
 *     false`, and every lifecycle capability false. Observing events is never
 *     structured extraction.
 *   - The plugin generation table (`OPENCODE_PLUGIN_GENERATIONS`) is explicit data:
 *     V1 and V2 are distinct surfaces and are never mixed in one configuration.
 *     `openCodePluginGeneration` parses the generation the installed file itself
 *     declares; an unknown declaration is an explicit unsupported result, never a
 *     guess. `validateOpenCodeGenerations` fails a mixed set explicitly.
 *   - `writeOpenCodePlugin` records the ONE managed static file 37soul installs —
 *     the "installed" state. It is a file write WE performed, so it never makes any
 *     doctor state green. `inspectOpenCodePlugin` reports a six-state doctor view
 *     and returns "trusted" only from OpenCode-authored load+trust markers in
 *     OpenCode's own config; it never turns green from our own write.
 *   - `extract()` runs the native model ONLY through `deps.invoke` (never a raw
 *     spawn). `buildOpenCodeExtractionInvocation` is the single exported command
 *     builder; its args are UNVERIFIED and no supported version is registered, so
 *     the P0 matrix row for OpenCode stays 未验. `extract()` uses the fixed bridge
 *     generation this adapter ships and never mixes generations.
 *
 * Session identity: a native session id always arrives via the request/event key
 * (from the plugin-bridged SessionStart), never from the process cwd or a
 * process-global like SOUL37_HOST_ID. Binding resolution (bindings.ts) therefore
 * refuses to guess: a reset to a new session without an explicit soul gets null.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextBundle } from "../assets/protocol.js";
import { buildExtractionInvocation, parseExtractionOutput } from "./claude-code.js";
import {
  OPENCODE_PLUGIN_FILENAME,
  OPENCODE_PLUGIN_GENERATION,
  OPENCODE_PLUGIN_SOURCE,
} from "./plugins/opencode.js";
export { OPENCODE_PLUGIN_FILENAME, OPENCODE_PLUGIN_GENERATION, OPENCODE_PLUGIN_SOURCE };
import type {
  AdapterDeps,
  ExtractionRequest,
  ExtractionResult,
  InjectionResult,
  RuntimeAdapter,
  RuntimeProbe,
} from "./types.js";

export type OpenCodePluginGeneration = "v1" | "v2";

/**
 * The supported plugin API generations, as explicit data. `verified` is false for
 * both: no authorized live probe has confirmed either surface against a real
 * OpenCode host. V1 and V2 must never be mixed in one configuration.
 */
export const OPENCODE_PLUGIN_GENERATIONS: Readonly<
  Record<OpenCodePluginGeneration, { generation: OpenCodePluginGeneration; verified: boolean }>
> = {
  v1: { generation: "v1", verified: false },
  v2: { generation: "v2", verified: false },
};

export type OpenCodeGenerationParse =
  | { generation: OpenCodePluginGeneration }
  | { unsupported: true; declared: string };

/**
 * Read the generation an installed plugin file declares for itself. An unknown
 * declaration is an explicit unsupported result — never a guess at which surface
 * to use.
 */
export function openCodePluginGeneration(text: string): OpenCodeGenerationParse {
  const match = /\bapi_generation\s*[:=]\s*["']?(v[0-9]+)["']?/i.exec(text);
  if (!match) return { unsupported: true, declared: "" };
  const declared = match[1].toLowerCase();
  if (declared === "v1" || declared === "v2") return { generation: declared };
  return { unsupported: true, declared };
}

export type OpenCodeGenerationValidation =
  | { generation: OpenCodePluginGeneration }
  | { unsupported: true; reason: "mixed_generation" | "unknown_generation" };

/**
 * Two plugin API generations must never coexist in one configuration. A mixed or
 * unknown set is an explicit failure — the caller never has to pick one.
 */
export function validateOpenCodeGenerations(
  declared: readonly string[],
): OpenCodeGenerationValidation {
  const known: OpenCodePluginGeneration[] = [];
  for (const value of declared) {
    const lower = String(value).toLowerCase();
    if (lower !== "v1" && lower !== "v2") return { unsupported: true, reason: "unknown_generation" };
    known.push(lower);
  }
  if (known.length === 0) return { unsupported: true, reason: "unknown_generation" };
  if (known.some((generation) => generation !== known[0])) {
    return { unsupported: true, reason: "mixed_generation" };
  }
  return { generation: known[0] };
}

/** OpenCode's own config directory (XDG-style, macOS). */
export function openCodeConfigDir(home: string): string {
  return path.join(home, ".config", "opencode");
}

/** The plugin directory install writes the ONE managed file into. */
export function openCodePluginDir(home: string): string {
  return path.join(openCodeConfigDir(home), "plugins");
}

/** The exact path of the managed plugin file (the only entry 37soul owns). */
export function openCodePluginPath(home: string): string {
  return path.join(openCodePluginDir(home), OPENCODE_PLUGIN_FILENAME);
}

/** OpenCode's own config file (the only place load/trust markers may live). */
export function openCodeConfigPath(home: string): string {
  return path.join(openCodeConfigDir(home), "opencode.json");
}

/** The SHA-256 of the plugin source install writes (recorded in the manifest). */
export function openCodePluginSha256(): string {
  return createHash("sha256").update(OPENCODE_PLUGIN_SOURCE, "utf8").digest("hex");
}

interface OpenCodeHostConfig {
  plugins?: unknown;
  plugin_trust?: unknown;
  model_refused?: unknown;
}

function readOpenCodeHostConfig(home: string): OpenCodeHostConfig {
  try {
    return JSON.parse(readFileSync(openCodeConfigPath(home), "utf8")) as OpenCodeHostConfig;
  } catch {
    return {};
  }
}

function isPluginLoaded(config: OpenCodeHostConfig): boolean {
  if (Array.isArray(config.plugins)) return config.plugins.includes(OPENCODE_PLUGIN_FILENAME);
  return typeof config.plugins === "string" && config.plugins === OPENCODE_PLUGIN_FILENAME;
}

function isPluginTrusted(config: OpenCodeHostConfig): boolean {
  const trust = config.plugin_trust;
  if (Array.isArray(trust)) return trust.includes(OPENCODE_PLUGIN_FILENAME);
  if (trust && typeof trust === "object" && !Array.isArray(trust)) {
    return (trust as Record<string, unknown>)[OPENCODE_PLUGIN_FILENAME] === true;
  }
  return false;
}

export type OpenCodePluginStatus =
  | "not_installed"
  | "unsupported_generation"
  | "not_loaded"
  | "not_trusted"
  | "model_refused"
  | "observation_only";

export interface OpenCodeInspection {
  status: OpenCodePluginStatus;
  generation: OpenCodePluginGeneration | null;
  declared: string;
}

/**
 * The six-state doctor view. Every state comes from reading OpenCode's own config
 * or the installed file's own declaration — never from a write we performed.
 * `observation_only` is the ceiling until an authorized live probe exists: events
 * may be observed, but no model call is authorized, so structured extraction stays
 * off.
 */
export function inspectOpenCodePlugin(home: string): OpenCodeInspection {
  let text = "";
  try {
    text = readFileSync(openCodePluginPath(home), "utf8");
  } catch {
    return { status: "not_installed", generation: null, declared: "" };
  }
  const parsed = openCodePluginGeneration(text);
  if ("unsupported" in parsed) {
    return { status: "unsupported_generation", generation: null, declared: parsed.declared };
  }
  const config = readOpenCodeHostConfig(home);
  if (!isPluginLoaded(config)) {
    return { status: "not_loaded", generation: parsed.generation, declared: parsed.generation };
  }
  if (!isPluginTrusted(config)) {
    return { status: "not_trusted", generation: parsed.generation, declared: parsed.generation };
  }
  if (config.model_refused === true) {
    return { status: "model_refused", generation: parsed.generation, declared: parsed.generation };
  }
  return { status: "observation_only", generation: parsed.generation, declared: parsed.generation };
}

/**
 * Install the ONE managed static plugin file. Backs up a pre-existing file only
 * when its content differs, and replaces only this entry — another vendor's plugin
 * file in the same directory is never touched. Returns the exact path, SHA-256 and
 * generation for the install manifest.
 */
export function writeOpenCodePlugin(home: string): {
  installed: boolean;
  path: string;
  sha256: string;
  generation: OpenCodePluginGeneration;
} {
  const file = openCodePluginPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // nothing installed yet
  }
  if (existing !== "" && existing !== OPENCODE_PLUGIN_SOURCE) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    writeFileSync(`${file}.37soul-${stamp}.bak`, existing, { mode: 0o600 });
  }
  writeFileSync(file, OPENCODE_PLUGIN_SOURCE, { mode: 0o600 });
  return {
    installed: true,
    path: file,
    sha256: openCodePluginSha256(),
    generation: OPENCODE_PLUGIN_GENERATION,
  };
}

/** Remove the managed plugin file; returns false when there is nothing to remove. */
export interface OpenCodePluginRemoval {
  /** The managed entry is gone (removed, or nothing was installed). */
  removed: boolean;
  /** A differing file was preserved as a timestamped `.37soul-*.bak` before removal. */
  backed_up: boolean;
  /** An unreadable file was left untouched (nothing removed). */
  preserved: boolean;
}

/**
 * Remove the managed plugin file, hash-aware: the on-disk content is compared with
 * the install manifest's recorded SHA-256 (passed in by the installer), so a user-
 * or OpenCode-modified file is backed up (same `.37soul-*.bak` convention as
 * install) before the managed entry is removed — a modified file is never destroyed
 * outright. An unreadable file is preserved and reported, never deleted. Without a
 * recorded hash the file is treated as unverifiable and backed up too.
 */
export function removeOpenCodePlugin(home: string, opts: { expectedSha256?: string } = {}): OpenCodePluginRemoval {
  const file = openCodePluginPath(home);
  if (!existsSync(file)) return { removed: false, backed_up: false, preserved: false };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Unreadable (e.g. permission denied): preserve it, report, remove nothing.
    return { removed: false, backed_up: false, preserved: true };
  }
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  const unchanged = opts.expectedSha256 !== undefined && actual === opts.expectedSha256;
  if (!unchanged) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    writeFileSync(`${file}.37soul-${stamp}.bak`, text, { mode: 0o600 });
  }
  rmSync(file, { force: true });
  return { removed: true, backed_up: !unchanged, preserved: false };
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
 * The first completed turn's record refs plus the native session id. Walk records
 * from the first `request` boundary, collecting the request id and every following
 * `message`/`tool` id until the NEXT `request` boundary — the first turn is exactly
 * the completed turn, and no later turn, meta record or compaction record leaks in.
 * The session id comes from the transcript itself (a session.created record), never
 * from the file path or a process-global.
 */
export function opencodeCompletedTurnRefs(jsonl: string, latest = false): { session_id: string | null; refs: string[] } {
  const records = parseJsonl(jsonl);
  let sessionId: string | null = null;
  for (const record of records) {
    if (typeof record.session_id === "string" && record.session_id !== "") {
      sessionId = record.session_id;
      break;
    }
  }
  const refs: string[] = [];
  let turnStarted = false;
  for (const record of records) {
    if (record.type === "request") {
      if (latest) {
        refs.length = 0;
        turnStarted = true;
        if (typeof record.id === "string" && record.id !== "") refs.push(record.id);
        continue;
      }
      if (turnStarted) break; // the next request begins: the first turn is complete
      turnStarted = true;
      if (typeof record.id === "string" && record.id !== "") refs.push(record.id);
      continue;
    }
    if (!turnStarted) continue; // session/meta records before the first request
    if (record.type === "message" || record.type === "tool") {
      if (typeof record.id === "string" && record.id !== "") refs.push(record.id);
    }
  }
  return { session_id: sessionId, refs };
}

export function latestOpenCodeCompletedTurnRefs(jsonl: string): { session_id: string | null; refs: string[] } {
  return opencodeCompletedTurnRefs(jsonl, true);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderOpenCodeRequestText(record: Record<string, any>): string {
  return typeof record.prompt === "string" ? record.prompt : "";
}

function renderOpenCodeMessageText(record: Record<string, any>): string {
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .map((block: any) =>
        block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string"
          ? block.text
          : "",
      )
      .filter((part: string) => part.trim() !== "")
      .join("\n");
  }
  return "";
}

function summarizeOpenCodeToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncate(input.trim(), 200);
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "file_path", "path", "query", "description"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return truncate(value.trim(), 200);
    }
    try {
      return truncate(JSON.stringify(input), 200);
    } catch {
      return "";
    }
  }
  return truncate(String(input), 200);
}

function truncateOpenCodeToolOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return truncate(output.trim(), 500);
  try {
    return truncate(JSON.stringify(output), 500);
  } catch {
    return "";
  }
}

/**
 * The bounded raw text of one completed turn. `refs` are the ids from
 * `opencodeCompletedTurnRefs`; a real `readSource` renders exactly those records.
 */
export function renderOpenCodeTurn(jsonl: string, refs: readonly string[]): string {
  const wanted = new Set(refs);
  const lines: string[] = [];
  for (const record of parseJsonl(jsonl)) {
    if (typeof record.id !== "string" || !wanted.has(record.id)) continue;
    if (record.type === "request") {
      const text = renderOpenCodeRequestText(record);
      if (text.trim() !== "") lines.push(`User: ${text}`);
    } else if (record.type === "message") {
      const text = renderOpenCodeMessageText(record);
      if (text.trim() !== "") lines.push(`Assistant: ${text}`);
    } else if (record.type === "tool") {
      const name = typeof record.name === "string" && record.name !== "" ? record.name : "tool";
      const summary = [summarizeOpenCodeToolInput(record.input), truncateOpenCodeToolOutput(record.output)]
        .filter((part) => part.trim() !== "")
        .join(" => ");
      lines.push(summary ? `[tool:${name} ${summary}]` : `[tool:${name}]`);
    }
  }
  return lines.join("\n");
}

/**
 * The native invocation for extraction, isolated in one exported builder so the
 * "invoked only via deps.invoke" invariant stays auditable. V1 and V2 are never
 * mixed: exactly one generation's args are produced, and an unknown generation is
 * an explicit unsupported result. UNVERIFIED: no authorized live probe has
 * confirmed OpenCode's non-interactive structured-output invocation, so the P0
 * matrix row stays 未验 and no supported version is registered from this surface.
 * The prompt is shared with the Claude adapter.
 */
export function buildOpenCodeExtractionInvocation(
  request: ExtractionRequest,
  turnText: string,
  generation: string,
): { args: readonly string[]; input: string } | { unsupported: true; declared: string } {
  const { input } = buildExtractionInvocation(request, turnText);
  switch (generation) {
    case "v1":
      return { args: ["run", "--format", "json"], input };
    case "v2":
      return { args: ["run", "--format", "json", "--standalone"], input };
    default:
      return { unsupported: true, declared: generation };
  }
}

export function createOpenCodeAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "opencode",

    async probe(): Promise<RuntimeProbe> {
      // Only observed capability. The plugin bridge is unverified and observing
      // events is never structured extraction: nothing lifecycle-derived is
      // reported as available.
      return {
        runtime_kind: "opencode",
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
      // 1. Read the raw transcript through the ONLY raw-source seam.
      const transcript = await deps.readSource(request.source_event_refs);
      // 2. Resolve the completed turn's concrete refs (no later turn / meta record).
      const refs = request.source_turn_refs && request.source_turn_refs.length > 0
        ? request.source_turn_refs.slice()
        : opencodeCompletedTurnRefs(transcript).refs;
      if (refs.length === 0) return { error: { code: "source_unavailable", retryable: true } };
      // 3. Render exactly the completed turn from the already-read source — the
      //    readSource seam is hit once (bounded); the turn is a local subset of it.
      const turnText = renderOpenCodeTurn(transcript, refs);
      // 4. Invoke the native model through deps.invoke, tagged with the job uid,
      //    using the ONE bridge generation this adapter ships (never mixed).
      const built = buildOpenCodeExtractionInvocation(request, turnText, OPENCODE_PLUGIN_GENERATION);
      if ("unsupported" in built) {
        return { error: { code: "unsupported_generation", retryable: false } };
      }
      const result = await deps.invoke("opencode", built.args, built.input, request.job_uid);
      if (result.code !== 0) return { error: { code: "model_error", retryable: true } };
      return parseExtractionOutput(result.stdout, request, refs);
    },

    async inject(bundle: ContextBundle): Promise<InjectionResult> {
      const rendered_sha256 = createHash("sha256")
        .update(bundle.rendered_text ?? "", "utf8")
        .digest("hex");
      // Injection is delivered by the unverified plugin bridge at the next request
      // boundary: the adapter cannot claim the context reached a session.
      return { delivered: false, rendered_sha256, error: "opencode_plugin_unverified" };
    },
  };
}
