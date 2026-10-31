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
 *   - `extract()` is unsupported here: no verified native invocation exists yet, and
 *     this adapter must not invent one. It returns an explicit unsupported error that
 *     the scheduler treats as a normal, non-retryable failure.
 *
 * Session identity: a native session id always arrives via the request/event key
 * (from the bridged session_start), never from the process cwd.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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
      // Same short-circuit as every other adapter: resolve the bounded source first
      // and never fabricate it. An empty resolution is a normal, retryable
      // source_unavailable — not an attempt to run a model.
      const source = await deps.readSource(request.source_event_refs ?? [], request.source_turn_refs);
      if (!source.trim()) {
        return { error: { code: "source_unavailable", retryable: true } };
      }
      // Source exists but Pi has no verified native invocation yet: refuse
      // explicitly rather than inventing a command line. Non-retryable on purpose —
      // retrying the same unverifiable shape would only burn quota.
      return { error: { code: "unsupported", retryable: false } };
    },

    async inject(_bundle: ContextBundle): Promise<InjectionResult> {
      return { delivered: false, rendered_sha256: "", error: "pi_injection_unverified" };
    },
  };
}
