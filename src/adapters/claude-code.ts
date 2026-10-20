/**
 * Task 6: the Claude Code runtime adapter.
 *
 * Lifecycle (already confirmed on the host):
 *   - SessionStart (`startup|resume|clear|compact`) carries the native session id
 *     and is the before-request injection channel.
 *   - Stop fires after a completed turn; UserPromptSubmit / PostToolUse /
 *     PreCompact / SessionEnd round out the spool + runtime-event stream.
 *
 * Extraction uses the P0-locked native model capability (`claude -p --output-format
 * json`): the adapter reads the raw transcript through the `readSource` seam (the
 * ONLY raw-source reader), resolves the single completed turn's concrete record
 * refs (never a sidechain, system record, meta record or a later turn), re-reads
 * exactly those refs, and invokes the model via `deps.invoke` — never a raw spawn.
 * The internal job uid tags the subprocess so its own hooks cannot recurse. Raw
 * JSONL stays local: the old TranscriptUpload flush path is never touched.
 *
 * Injection is a local receipt: `inject()` reports `delivered` plus the rendered
 * text's SHA-256; the hook performs the actual stdout write and records the
 * `injected` receipt only after that write succeeds.
 */
import { createHash } from "node:crypto";
import type {
  AdapterDeps,
  ExtractionRequest,
  ExtractionResult,
  InjectionResult,
  RuntimeAdapter,
  RuntimeProbe,
} from "./types.js";
import type {
  AssetTrait,
  ContextBundle,
  Evidence,
  ProposedAsset,
  Sensitivity,
  Verification,
} from "../assets/protocol.js";
import { isSkippedRecord, summarizeToolInput } from "../agentd/parsers/claude-code.js";

/** The Claude Code lifecycle events the installer subscribes to (single source of truth). */
export const CLAUDE_CODE_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: "SessionStart", matcher: "startup|resume|clear|compact" },
  { event: "UserPromptSubmit" },
  { event: "PostToolUse" },
  { event: "PostToolUseFailure" },
  { event: "Stop" },
  { event: "PreCompact" },
  { event: "SessionEnd" },
];

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
 * The first completed turn's record refs. Walk the `parentUuid` chain from the
 * first human user message (a `parentUuid: null` user record), taking the first
 * (chronologically earliest) non-skipped child at each step — a sidechain record
 * written before the main-chain child is never followed — and stopping at any
 * sidechain / system / meta / attachment boundary. At Stop time a SessionStart
 * transcript's first turn is exactly the completed turn.
 */
export function completedTurnSourceRefs(jsonl: string): string[] {
  const records = parseJsonl(jsonl);

  let root: Record<string, any> | null = null;
  for (const record of records) {
    if (isSkippedRecord(record)) continue;
    if (record.parentUuid === null && record.type === "user") {
      root = record;
      break;
    }
  }
  if (!root) return [];

  const refs: string[] = [];
  const seen = new Set<string>();
  let current: Record<string, any> | null = root;
  while (current) {
    if (isSkippedRecord(current)) break;
    const uuid = typeof current.uuid === "string" ? current.uuid : null;
    if (uuid === null || seen.has(uuid)) break;
    seen.add(uuid);
    refs.push(uuid);

    let child: Record<string, any> | null = null;
    for (const record of records) {
      if (record.parentUuid === uuid && !isSkippedRecord(record)) {
        child = record;
        break;
      }
    }
    current = child;
  }
  return refs;
}

/** The bounded raw text of one turn: user/assistant text plus tool activity. */
export function renderSourceTurn(jsonl: string, refs: readonly string[]): string {
  const wanted = new Set(refs);
  const lines: string[] = [];
  for (const record of parseJsonl(jsonl)) {
    if (typeof record.uuid !== "string" || !wanted.has(record.uuid)) continue;
    const text = renderRecordText(record).trim();
    if (text !== "") lines.push(text);
  }
  return lines.join("\n");
}

function renderRecordText(record: Record<string, any>): string {
  const content = record.message?.content;
  if (record.type === "user") {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => {
          if (block?.type === "text" && typeof block.text === "string") return block.text;
          if (block?.type === "tool_result") return contentText(block.content);
          return "";
        })
        .filter((part: string) => part.trim() !== "")
        .join("\n");
    }
    return "";
  }
  if (record.type === "assistant") {
    if (!Array.isArray(content)) return "";
    return content
      .map((block: any) => {
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "tool_use") {
          const name = typeof block.name === "string" && block.name ? block.name : "tool";
          const summary = summarizeToolInput(block.input);
          return summary ? `[tool:${name} ${summary}]` : `[tool:${name}]`;
        }
        return "";
      })
      .filter((part: string) => part.trim() !== "")
      .join("\n");
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

/** The native invocation for extraction: structured JSON output, prompt on stdin.
 *  Exported so the "invoked only via deps.invoke" invariant stays auditable. */
export function buildExtractionInvocation(
  _request: ExtractionRequest,
  turnText: string,
): { args: readonly string[]; input: string } {
  const input = [
    "Extract portable memory assets from the completed turn below.",
    'Respond with a JSON array of proposal objects, each with exactly: "kind" ("relationship"|"experience"),',
    '"trait" ("fact"|"event"|"preference"|"promise"), "content", "applicability", "tags" (array of strings),',
    '"evidence" ("explicit_user_statement"|"inference"|"observed_result"), "verification" ("unverified"|"confirmed"),',
    '"sensitivity" ("normal"|"sensitive"). Do not include a "source": the client pins it locally.',
    "Return [] when nothing is worth remembering.",
    "",
    "--- completed turn ---",
    turnText,
  ].join("\n");
  return { args: ["-p", "--output-format", "json"], input };
}

const TRAITS: readonly AssetTrait[] = ["fact", "event", "preference", "promise"];
const EVIDENCES: readonly Evidence[] = ["explicit_user_statement", "inference", "observed_result"];

function asTrait(value: unknown, kind: "relationship" | "experience"): AssetTrait {
  if (kind === "experience") return "fact"; // experience assets must use trait fact
  return (TRAITS as readonly unknown[]).includes(value) ? (value as AssetTrait) : "fact";
}

function asEvidence(value: unknown): Evidence {
  return (EVIDENCES as readonly unknown[]).includes(value) ? (value as Evidence) : "observed_result";
}

/** Parse the model's structured output into validated-shape proposals. The model is
 *  never allowed to claim a source: runtime_kind/session_ref are pinned by the
 *  scheduler, and event_ref/occurred_at are filled from the local completed turn. */
export function parseExtractionOutput(
  stdout: string,
  request: ExtractionRequest,
  turnRefs: readonly string[],
): ExtractionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { error: { code: "unstructured_output", retryable: false } };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { proposals?: unknown } | null)?.proposals;
  if (!Array.isArray(list)) return { error: { code: "unstructured_output", retryable: false } };

  const occurredAt = new Date().toISOString();
  const eventRef = String(turnRefs[0] ?? request.source_event_refs[0] ?? "").slice(0, 128);
  const proposals: ProposedAsset[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (content === "") continue;
    const kind = record.kind === "experience" ? "experience" : "relationship";
    proposals.push({
      kind,
      trait: asTrait(record.trait, kind),
      content,
      applicability: typeof record.applicability === "string" ? record.applicability : "",
      tags: Array.isArray(record.tags)
        ? record.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      evidence: asEvidence(record.evidence),
      verification: record.verification === "confirmed" ? "confirmed" : ("unverified" as Verification),
      sensitivity: record.sensitivity === "sensitive" ? "sensitive" : ("normal" as Sensitivity),
      source: {
        runtime_kind: request.runtime_kind,
        session_ref: "",
        event_ref: eventRef,
        occurred_at: occurredAt,
      },
    });
  }
  return { proposals };
}

export function createClaudeCodeAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "claude-code",

    async probe(): Promise<RuntimeProbe> {
      // Observed capabilities of the native host. version is "unverified" until an
      // authorized live probe fills in the real CLI version.
      return {
        runtime_kind: "claude-code",
        version: "0.0.0-unverified",
        session_id: true,
        before_request: true,
        structured_extraction: true,
        internal_marker: true,
        resume: true,
        compact: true,
        interrupt: true,
      };
    },

    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      // 1. Read the raw transcript through the ONLY raw-source seam.
      const transcript = await deps.readSource(request.source_event_refs);
      // 2. Resolve the completed turn's concrete refs (no sidechain / later turn).
      const turnRefs = completedTurnSourceRefs(transcript);
      if (turnRefs.length === 0) return { proposals: [] };
      // 3. Render exactly the completed turn from the already-read source — the
      //    readSource seam is hit once (bounded); the turn is a local subset of it.
      const turnText = renderSourceTurn(transcript, turnRefs);
      // 4. Invoke the native model through deps.invoke, tagged with the job uid.
      const { args, input } = buildExtractionInvocation(request, turnText);
      const result = await deps.invoke("claude-code", args, input, request.job_uid);
      if (result.code !== 0) return { error: { code: "model_error", retryable: true } };
      return parseExtractionOutput(result.stdout, request, turnRefs);
    },

    async inject(bundle: ContextBundle): Promise<InjectionResult> {
      const rendered_sha256 = createHash("sha256")
        .update(bundle.rendered_text ?? "", "utf8")
        .digest("hex");
      return { delivered: true, rendered_sha256 };
    },
  };
}
