/**
 * Task 9: the Hermes runtime adapter plus its managed Python bridge.
 *
 * Honesty contract (same as Codex/OpenCode, applied to an unverified CLI host):
 *   - There is no authorized live probe (the plan records Hermes 0.21.0 as
 *     P0-observed — an *observed* string, never a registered supported version).
 *     `probe()` therefore reports only observed capability: version
 *     "0.0.0-unverified", `structured_extraction: false`, and every lifecycle
 *     capability false.
 *   - A gateway-only event stream is never judged as CLI capability: `probe()`
 *     (and `extract()`) refuse the gateway surface explicitly instead of
 *     pretending the already-logged-in CLI can extract. `detectHermesSurface`
 *     reads only Hermes's own config shape (UNVERIFIED) and `hermesEventSurface`
 *     classifies a raw stream; neither ever reads extra user keys or secrets.
 *   - `writeHermesPlugin` records the ONE managed static Python file 37soul
 *     installs — the "installed" state. It is a file write WE performed, so it
 *     never makes any doctor state green. `inspectHermesPlugin` reports a three-
 *     state doctor view whose ceiling is `observation_only`.
 *   - `extract()` runs the native model ONLY through `deps.invoke` (never a raw
 *     spawn, never a network call, never a gateway key). `buildHermesExtractionInvocation`
 *     is the single exported command builder; its args are UNVERIFIED and no
 *     supported version is registered, so the P0 matrix row for Hermes stays 未验.
 *
 * Session identity: a native session id always arrives via the request/event key
 * (from the bridge's modeled SessionStart), never from the process cwd or a
 * process-global like SOUL37_HOST_ID. Binding resolution (bindings.ts) therefore
 * refuses to guess: a reset to a new session without an explicit soul gets null.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextBundle } from "../assets/protocol.js";
import { buildExtractionInvocation, parseExtractionOutput } from "./claude-code.js";
import { HERMES_PLUGIN_FILENAME, HERMES_PLUGIN_SOURCE } from "./plugins/hermes.js";
export { HERMES_PLUGIN_FILENAME, HERMES_PLUGIN_SOURCE };
import type {
  AdapterDeps,
  ExtractionRequest,
  ExtractionResult,
  InjectionResult,
  RuntimeAdapter,
  RuntimeProbe,
} from "./types.js";

/** The Hermes config surface the adapter can observe (UNVERIFIED config shape). */
export type HermesSurface = "gateway" | "cli" | "none";

/** The surface a raw event stream declares (a stream is never "none"). */
export type HermesEventSurface = "gateway" | "cli" | "unknown";

/** Hermes's own config directory (modeled; UNVERIFIED against a live Hermes host). */
export function hermesConfigDir(home: string): string {
  return path.join(home, ".hermes");
}

/** Hermes's own config file (the only place a transport/gateway marker may live). */
export function hermesConfigPath(home: string): string {
  return path.join(hermesConfigDir(home), "config.json");
}

/** The plugin directory install writes the ONE managed bridge file into. */
export function hermesPluginDir(home: string): string {
  return path.join(hermesConfigDir(home), "plugin");
}

/** The exact path of the managed bridge file (the only entry 37soul owns). */
export function hermesPluginPath(home: string): string {
  return path.join(hermesPluginDir(home), HERMES_PLUGIN_FILENAME);
}

/** The SHA-256 of the bridge source install writes (recorded in the manifest). */
export function hermesPluginSha256(): string {
  return createHash("sha256").update(HERMES_PLUGIN_SOURCE, "utf8").digest("hex");
}

/**
 * A gateway-only config declares a remote gateway transport (a hosted model
 * gateway) instead of the already-logged-in local CLI. UNVERIFIED config shape:
 * modeled as either a `transport: "gateway"` field or a `gateway` object with a
 * `url`. Anything else that is present is treated as a (still unverified) CLI
 * surface; an absent/empty config is "none".
 */
function isGatewayConfig(text: string): boolean {
  if (text.trim() === "") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (record.transport === "gateway") return true;
    const gateway = record.gateway;
    if (gateway !== null && typeof gateway === "object" && !Array.isArray(gateway)) {
      const url = (gateway as Record<string, unknown>).url;
      if (typeof url === "string" && url !== "") return true;
    }
  }
  return false;
}

/**
 * Read Hermes's own config and report which surface it declares. Never reads
 * extra user keys or config secrets: only the transport/gateway marker is
 * inspected, and only to refuse the gateway surface honestly.
 */
export function detectHermesSurface(home: string): HermesSurface {
  let text = "";
  try {
    text = readFileSync(hermesConfigPath(home), "utf8");
  } catch {
    // no config yet
  }
  if (isGatewayConfig(text)) return "gateway";
  if (text.trim() !== "" || existsSync(hermesConfigDir(home))) return "cli";
  return "none";
}

/**
 * Classify a raw event stream. Gateway records (`gateway.event` or a `gateway`
 * field) are never CLI records; a stream with only gateway records is "gateway".
 * UNVERIFIED: the record shapes are modeled, not confirmed by a live probe.
 */
export function hermesEventSurface(jsonl: string): HermesEventSurface {
  const records = parseJsonl(jsonl);
  if (records.length === 0) return "unknown";
  let sawGateway = false;
  let sawCli = false;
  for (const record of records) {
    if (record.type === "gateway.event" || typeof record.gateway === "string") sawGateway = true;
    if (record.type === "session.started" || record.type === "user_message" || record.type === "request") {
      sawCli = true;
    }
  }
  if (sawGateway && !sawCli) return "gateway";
  if (sawCli) return "cli";
  return "unknown";
}

/**
 * The honest probe: only observed capability. A gateway-only surface is never
 * judged as CLI capability, and the CLI surface is unverified (no authorized live
 * probe), so `structured_extraction` and every lifecycle capability stay false.
 * The plan's "Hermes 0.21.0" may appear as an observed string in docs, never here.
 */
export function hermesProbe(_surface: HermesSurface = "none"): RuntimeProbe {
  return {
    runtime_kind: "hermes",
    version: "0.0.0-unverified",
    session_id: false,
    before_request: false,
    structured_extraction: false,
    internal_marker: false,
    resume: false,
    compact: false,
    interrupt: false,
  };
}

export type HermesPluginStatus = "not_installed" | "gateway_only" | "observation_only";

export interface HermesInspection {
  status: HermesPluginStatus;
  surface: HermesSurface;
}

/**
 * The three-state doctor view. `gateway_only` is reported explicitly when the
 * config declares a remote gateway — doctor/probe never pretend the CLI can
 * extract. `observation_only` is the ceiling for a CLI surface until an
 * authorized live probe exists: events may be observed, but no model call is
 * authorized, so structured extraction stays off.
 */
export function inspectHermesPlugin(home: string): HermesInspection {
  const surface = detectHermesSurface(home);
  if (surface === "gateway") return { status: "gateway_only", surface };
  if (!existsSync(hermesPluginPath(home))) return { status: "not_installed", surface };
  return { status: "observation_only", surface };
}

/**
 * Install the ONE managed static Python bridge file. Backs up a pre-existing file
 * only when its content differs, and replaces only this entry — another vendor's
 * plugin file in the same directory is never touched. Returns the exact path and
 * SHA-256 for the install manifest.
 */
export function writeHermesPlugin(home: string): { installed: boolean; path: string; sha256: string } {
  const file = hermesPluginPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(file, "utf8");
  } catch {
    // nothing installed yet
  }
  if (existing !== "" && existing !== HERMES_PLUGIN_SOURCE) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    writeFileSync(`${file}.37soul-${stamp}.bak`, existing, { mode: 0o600 });
  }
  writeFileSync(file, HERMES_PLUGIN_SOURCE, { mode: 0o600 });
  return { installed: true, path: file, sha256: hermesPluginSha256() };
}

export interface HermesPluginRemoval {
  /** The managed entry is gone (removed, or nothing was installed). */
  removed: boolean;
  /** A differing file was preserved as a timestamped `.37soul-*.bak` before removal. */
  backed_up: boolean;
  /** An unreadable file was left untouched (nothing removed). */
  preserved: boolean;
}

/**
 * Remove the managed bridge file, hash-aware: the on-disk content is compared with
 * the install manifest's recorded SHA-256 (passed in by the installer), so a user-
 * or Hermes-modified file is backed up before removal — a modified file is never
 * destroyed outright. An unreadable file is preserved and reported, never deleted.
 * Without a recorded hash the file is treated as unverifiable and backed up too.
 */
export function removeHermesPlugin(home: string, opts: { expectedSha256?: string } = {}): HermesPluginRemoval {
  const file = hermesPluginPath(home);
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
 * from the first `user_message`, collecting the ids of every following
 * `assistant_message`/`tool_call` until the NEXT `user_message` — the first turn is
 * exactly the completed turn, and no later turn, meta record or compaction record
 * leaks in. The session id comes from the transcript itself (session.started),
 * never from the file path or a process-global.
 */
export function hermesCompletedTurnRefs(jsonl: string): { session_id: string | null; refs: string[] } {
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
    if (record.type === "user_message") {
      if (turnStarted) break; // the next user message begins the next turn
      turnStarted = true;
      if (typeof record.id === "string" && record.id !== "") refs.push(record.id);
      continue;
    }
    if (!turnStarted) continue; // session/meta records before the first user message
    if (record.type === "assistant_message" || record.type === "tool_call") {
      if (typeof record.id === "string" && record.id !== "") refs.push(record.id);
    }
  }
  return { session_id: sessionId, refs };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function summarizeHermesToolInput(input: unknown): string {
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

function truncateHermesToolOutput(output: unknown): string {
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
 * `hermesCompletedTurnRefs`; a real `readSource` renders exactly those records.
 */
export function renderHermesTurn(jsonl: string, refs: readonly string[]): string {
  const wanted = new Set(refs);
  const lines: string[] = [];
  for (const record of parseJsonl(jsonl)) {
    if (typeof record.id !== "string" || !wanted.has(record.id)) continue;
    if (record.type === "user_message" || record.type === "assistant_message") {
      const text = typeof record.text === "string" ? record.text : "";
      if (text.trim() !== "") lines.push(text);
    } else if (record.type === "tool_call") {
      const name = typeof record.name === "string" && record.name !== "" ? record.name : "tool";
      const summary = [summarizeHermesToolInput(record.input), truncateHermesToolOutput(record.output)]
        .filter((part) => part.trim() !== "")
        .join(" => ");
      lines.push(summary ? `[tool:${name} ${summary}]` : `[tool:${name}]`);
    }
  }
  return lines.join("\n");
}

/**
 * The native invocation for extraction, isolated in one exported builder so the
 * "invoked only via deps.invoke" invariant stays auditable. UNVERIFIED: no
 * authorized live probe has confirmed Hermes's non-interactive structured-output
 * invocation, so the P0 matrix row stays 未验 and no supported version is
 * registered from this surface. The prompt is shared with the Claude adapter.
 */
export function buildHermesExtractionInvocation(
  request: ExtractionRequest,
  turnText: string,
): { args: readonly string[]; input: string } {
  const { input } = buildExtractionInvocation(request, turnText);
  return { args: ["run", "--output", "json"], input };
}

export function createHermesAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "hermes",

    async probe(): Promise<RuntimeProbe> {
      // Only observed capability; a gateway-only surface is never CLI capability.
      return hermesProbe(detectHermesSurface(deps.home));
    },

    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      // A gateway-only config has no already-logged-in CLI model: refuse rather
      // than pretending the visible quota can extract (and never read the gateway
      // key or any config secret).
      if (detectHermesSurface(deps.home) === "gateway") {
        return { error: { code: "gateway_only", retryable: false } };
      }
      // 1. Read the raw transcript through the ONLY raw-source seam.
      const transcript = await deps.readSource(request.source_event_refs);
      // A gateway-shaped event stream must refuse even when config detection is
      // inconclusive: gateway records are never fed to a model invocation.
      if (hermesEventSurface(transcript) === "gateway") {
        return { error: { code: "gateway_only", retryable: false } };
      }
      // 2. Resolve the completed turn's concrete refs (no later turn / meta record).
      const { refs } = hermesCompletedTurnRefs(transcript);
      if (refs.length === 0) return { proposals: [] };
      // 3. Re-read exactly the completed turn's source through the same seam.
      const turnText = await deps.readSource(refs);
      // 4. Invoke the native model through deps.invoke, tagged with the job uid.
      const { args, input } = buildHermesExtractionInvocation(request, turnText);
      const result = await deps.invoke("hermes", args, input, request.job_uid);
      if (result.code !== 0) return { error: { code: "model_error", retryable: true } };
      return parseExtractionOutput(result.stdout, request, refs);
    },

    async inject(bundle: ContextBundle): Promise<InjectionResult> {
      const rendered_sha256 = createHash("sha256")
        .update(bundle.rendered_text ?? "", "utf8")
        .digest("hex");
      // Injection is delivered by the unverified Python bridge at the next request
      // boundary: the adapter cannot claim the context reached a session.
      return { delivered: false, rendered_sha256, error: "hermes_plugin_unverified" };
    },
  };
}
