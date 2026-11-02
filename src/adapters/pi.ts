/**
 * The Pi runtime adapter plus its managed extension bridge.
 *
 * Why this adapter exists: 37Soul's own team works inside Pi every day, and Pi was
 * detected by install but silently dropped (it was in `AGENT_HOMES`, not in
 * `SUPPORTED_AGENTS`). A capture path that skips the harness we use ourselves is
 * the one gap we can never dogfood around.
 *
 * Honesty contract (same as OpenCode/Hermes, applied to a documented-but-unproven
 * host surface):
 *   - `probe()` reports only observed capability. The Pi extension surface is
 *     documented and locally exercised, but no authorized live probe has confirmed
 *     structured extraction, so `structured_extraction` stays false and every
 *     lifecycle capability that we have not observed stays false. Observing events
 *     is never structured extraction.
 *   - `writePiExtension` records the ONE managed static file 37soul installs — the
 *     "installed" state. It is a write WE performed, so it never makes any doctor
 *     state green. `inspectPiExtension` reports Pi's own load state only from
 *     markers Pi itself writes; our own file never turns it green.
 *   - Extraction targets the Pi 1.4.0 native CLI with tools, extensions, session
 *     persistence and context discovery disabled. Live delivery remains unverified.
 *
 * Session identity: a native session id always arrives via the request/event key
 * (from the bridged session_start), never from the process cwd.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildExtractionInvocation, parseExtractionOutput } from "./claude-code.js";
import { serializeSourceTurn, type TurnMessage } from "./source-turn.js";
import type { ContextBundle } from "../assets/protocol.js";
import { PI_EXTENSION_FILENAME, PI_EXTENSION_GENERATION, PI_EXTENSION_SOURCE } from "./plugins/pi.js";
export { PI_EXTENSION_FILENAME, PI_EXTENSION_GENERATION, PI_EXTENSION_SOURCE };
import type {
  AdapterDeps,
  ExtractionRequest,
  ExtractionResult,
  InjectionResult,
  RuntimeAdapter,
  RuntimeProbe,
} from "./types.js";

export type PiExtensionGeneration = typeof PI_EXTENSION_GENERATION;

/**
 * Supported extension generations, as explicit data. `verified` is false: the
 * injection/extraction half has not been proven against a real Pi host, so no
 * generation may be reported as verified.
 */
export const PI_EXTENSION_GENERATIONS: Readonly<
  Record<PiExtensionGeneration, { generation: PiExtensionGeneration; verified: boolean }>
> = {
  [PI_EXTENSION_GENERATION]: { generation: PI_EXTENSION_GENERATION, verified: false },
};

/** Pi's user extensions directory (the only directory we write into). */
export function piExtensionsDir(home: string): string {
  return path.join(home, ".pi", "agent", "extensions");
}

/** The exact file install owns inside Pi's extensions directory. */
export function piExtensionPath(home: string): string {
  return path.join(piExtensionsDir(home), PI_EXTENSION_FILENAME);
}

export interface PiExtensionWrite {
  path: string;
  sha256: string;
  generation: PiExtensionGeneration;
  installed: boolean;
  /** True when a pre-existing file from another source was backed up first. */
  backedUp: boolean;
}

/**
 * Write the managed extension (idempotent). A pre-existing file at the same path
 * that is not ours is backed up to `<file>.bak-37soul` before replacement, so a
 * hand-written extension is never silently destroyed.
 */
export function writePiExtension(home: string, opts: { now?: () => number } = {}): PiExtensionWrite {
  const dir = piExtensionsDir(home);
  const file = piExtensionPath(home);
  const sha256 = createHash("sha256").update(PI_EXTENSION_SOURCE).digest("hex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let backedUp = false;
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8");
    if (current === PI_EXTENSION_SOURCE) {
      return { path: file, sha256, generation: PI_EXTENSION_GENERATION, installed: true, backedUp };
    }
    // Not ours (or an older ours): keep a copy before replacing.
    const stamp = new Date(opts.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    writeFileSync(`${file}.37soul-${stamp}.bak`, current, { mode: 0o600 });
    backedUp = true;
  }
  writeFileSync(file, PI_EXTENSION_SOURCE, { mode: 0o600 });
  return { path: file, sha256, generation: PI_EXTENSION_GENERATION, installed: true, backedUp };
}

export type PiDoctorStatus =
  | "not_installed" // our file is absent
  | "installed_unloaded" // our file is present; Pi has not loaded it (or we cannot tell)
  | "generation_unsupported"; // a file is present, but not a generation we ship

export interface PiExtensionInspection {
  status: PiDoctorStatus;
  path: string;
  generation: string | null;
  detail?: string;
}

/**
 * Read back what is on disk. The generation is parsed from the file's own literal
 * declaration — never guessed. Because Pi exposes no load marker we can read
 * without running it, a present file reports `installed_unloaded`: an honest
 * "we wrote it, we have not observed Pi loading it".
 */
export function inspectPiExtension(home: string): PiExtensionInspection {
  const file = piExtensionPath(home);
  if (!existsSync(file)) {
    return { status: "not_installed", path: file, generation: null };
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { status: "installed_unloaded", path: file, generation: null, detail: (error as Error).message };
  }
  const declared = /export\s+const\s+api_generation\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  if (declared !== PI_EXTENSION_GENERATION) {
    return {
      status: "generation_unsupported",
      path: file,
      generation: declared,
      detail: declared ? `found ${declared}, ship ${PI_EXTENSION_GENERATION}` : "no api_generation declared",
    };
  }
  return { status: "installed_unloaded", path: file, generation: declared };
}

export interface PiExtensionRemoval {
  path: string;
  /** The managed entry is gone (removed, or nothing was installed). */
  removed: boolean;
  /** A differing file was preserved as a timestamped `.37soul-*.bak` before removal. */
  backed_up: boolean;
  /** An unreadable file was left untouched (nothing removed). */
  preserved: boolean;
}

/**
 * Remove the managed extension, hash-aware: the on-disk content is compared with the
 * install manifest's recorded SHA-256 (passed in by the installer), so a user- or
 * Pi-modified file is backed up (same `.37soul-*.bak` convention as install) before
 * removal — a modified file is never destroyed outright. An unreadable file is
 * preserved and reported. A file that does not declare our generation is never ours
 * and is left completely alone.
 */
export function removePiExtension(
  home: string,
  opts: { expectedSha256?: string; now?: () => number } = {},
): PiExtensionRemoval {
  const file = piExtensionPath(home);
  if (!existsSync(file)) return { path: file, removed: false, backed_up: false, preserved: false };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { path: file, removed: false, backed_up: false, preserved: true };
  }
  if (!text.includes(`api_generation = "${PI_EXTENSION_GENERATION}"`)) {
    // Not a file we wrote: leave it alone.
    return { path: file, removed: false, backed_up: false, preserved: true };
  }
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  const unchanged = opts.expectedSha256 !== undefined && actual === opts.expectedSha256;
  if (!unchanged) {
    const stamp = new Date(opts.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    writeFileSync(`${file}.37soul-${stamp}.bak`, text, { mode: 0o600 });
  }
  rmSync(file, { force: true });
  return { path: file, removed: true, backed_up: !unchanged, preserved: false };
}

/** Observed Pi version from its installed release directory, when present. */
export function detectPiVersion(home: string): string | null {
  const releases = path.join(home, ".pi", "agent", "install", "releases");
  if (!existsSync(releases)) return null;
  try {
    const versions = readdirSync(releases);
    const semver = versions
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      });
    return semver[0] ?? null;
  } catch {
    return null;
  }
}

export function createPiAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "pi",

    async probe(): Promise<RuntimeProbe> {
      const version = detectPiVersion(deps.home);
      const inspection = inspectPiExtension(deps.home);
      return {
        // Never invent a version: absent evidence stays explicit.
        runtime_kind: "pi",
        version: version ?? "0.0.0-unverified",
        session_id: inspection.status !== "not_installed",
        // Injection is the bridged before_agent_start system-prompt append. It is
        // implemented and locally exercised, but not independently verified.
        before_request: false,
        structured_extraction: false,
        internal_marker: false,
        resume: false,
        compact: false,
        interrupt: false,
      };
    },

    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      const source = await deps.readSource(request.source_event_refs, request.source_turn_refs);
      const refs = latestPiCompletedTurnRefs(source);
      if (refs.length === 0 || (request.source_turn_refs !== undefined &&
          (request.source_turn_refs.length !== refs.length || refs.some((ref, i) => ref !== request.source_turn_refs![i])))) {
        return { error: { code: "source_unavailable", retryable: true } };
      }
      const turn = renderPiTurn(source, refs);
      if (!turn.trim()) return { error: { code: "source_unavailable", retryable: true } };
      const { input } = buildExtractionInvocation(request, turn);
      try {
        const result = await deps.invoke("pi", [
          "--print", "--mode", "text", "--no-session", "--no-tools",
          "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
        ], input, request.job_uid);
        if (result.code !== 0) return { error: { code: "model_error", retryable: true } };
        return parseExtractionOutput(result.stdout, request, refs);
      } catch {
        return { error: { code: "model_error", retryable: true } };
      }
    },

    async inject(_bundle: ContextBundle): Promise<InjectionResult> {
      return { delivered: false, rendered_sha256: "", error: "pi_injection_unverified" };
    },
  };
}


/** Pi 1.4.0 session v3 entries. Never convert custom messages or thinking to user evidence. */
function piEntries(jsonl: string): Array<Record<string, any>> {
  const entries: Array<Record<string, any>> = [];
  for (const line of jsonl.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry) &&
          entry.type !== "session" && typeof entry.id === "string" && entry.id) entries.push(entry);
    } catch { /* torn boundary lines are not evidence */ }
  }
  return entries;
}

/** Follow the persisted active leaf's parent chain, not chronological sibling messages. */
export function latestPiCompletedTurnRefs(jsonl: string): string[] {
  const entries = piEntries(jsonl);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  let entry = entries[entries.length - 1];
  while (entry) {
    if (seen.has(entry.id)) return [];
    seen.add(entry.id);
    branch.unshift(entry);
    if (entry.type === "message" && entry.message?.role === "user") break;
    if (typeof entry.parentId !== "string") return [];
    entry = byId.get(entry.parentId)!;
    if (!entry) return []; // bounded window omitted an ancestor of this turn
  }
  if (branch[0]?.message?.role !== "user") return [];
  const messages = branch.filter(entry => entry.type === "message" &&
    ["user", "assistant", "toolResult"].includes(entry.message?.role));
  const last = messages[messages.length - 1];
  if (last?.message?.role !== "assistant" || last.message.stopReason !== "stop") return [];
  return messages.map(entry => entry.id);
}

export function renderPiTurn(jsonl: string, refs: readonly string[]): string {
  const byId = new Map(piEntries(jsonl).map(entry => [entry.id, entry]));
  const messages: TurnMessage[] = [];
  for (const ref of refs) {
    const entry = byId.get(ref);
    if (!entry || entry.type !== "message") return "";
    const message = entry.message;
    const source = message?.role === "user" ? "user" : message?.role === "assistant" ? "assistant" : "tool";
    const content = typeof message?.content === "string" ? [{type: "text", text: message.content}] : message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        messages.push({ source, kind: source === "tool" ? "tool_result" : "text", text: part.text });
      } else if (source === "assistant" && part?.type === "toolCall") {
        messages.push({source: "tool", kind: "tool_call", name: String(part.name ?? "tool"),
          text: JSON.stringify(part.arguments ?? {}).slice(0, 1024)});
      }
    }
  }
  return serializeSourceTurn(messages);
}
