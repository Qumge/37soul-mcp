/**
 * Payload validation for soul-assets/v1 (§2.3, §5).
 *
 * `validateProposedAsset` strictly validates a wire-shaped propose payload
 * (snake_case) and returns the validated ProposedAsset, enforcing the fixed
 * enums, code-point length limits and the source field whitelist. `assertNoRawEnvelope`
 * rejects the raw-envelope fields (events/transcript/tool_output/cwd/files) at any
 * nesting level of a request, per the contract's field whitelist. Neither filter is
 * a secret-scanner guarantee; the shared privacy probe covers the leak matrix.
 */
import type { AssetSource, ProposedAsset } from "./protocol.js";
import {
  ASSET_TRAITS,
  EVIDENCES,
  LIMITS,
  SENSITIVITIES,
  VERIFICATIONS,
  codePoints,
} from "./protocol.js";

/** §5 raw-envelope fields: presence anywhere in a request rejects the whole request. */
export const RAW_ENVELOPE_FIELDS = ["events", "transcript", "tool_output", "cwd", "files"] as const;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** New client submissions: the four tools plus web; legacy is read-only on the cloud. */
const SUBMITTABLE_RUNTIME_KINDS = ["claude-code", "codex", "opencode", "hermes", "web"] as const;
const SOURCE_FIELDS = ["runtime_kind", "session_ref", "event_ref", "occurred_at"] as const;
const PROPOSED_ASSET_FIELDS = [
  "kind",
  "trait",
  "content",
  "applicability",
  "tags",
  "evidence",
  "verification",
  "sensitivity",
  "source",
] as const;

/** Reject any object graph containing a raw-envelope field key, at any depth. */
export function assertNoRawEnvelope(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawEnvelope(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if ((RAW_ENVELOPE_FIELDS as readonly string[]).includes(key)) {
        throw new ValidationError(`raw envelope field forbidden: ${key}`);
      }
      assertNoRawEnvelope(nested);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  return value;
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new ValidationError(`invalid ${field}: ${String(value)}`);
  }
  return value as T;
}

/**
 * Validate a wire-shaped propose payload (the `payload` of a propose Change) and
 * return the validated ProposedAsset. Unknown fields (top-level and in source)
 * are rejected, as are the fixed raw-envelope fields.
 */
export function validateProposedAsset(value: unknown): ProposedAsset {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("proposed asset must be an object");
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(PROPOSED_ASSET_FIELDS as readonly string[]).includes(key)) {
      throw new ValidationError(`unexpected proposed asset field: ${key}`);
    }
  }

  const kind = requireEnum(record.kind, "kind", ["relationship", "experience"] as const);
  const trait = requireEnum(record.trait, "trait", ASSET_TRAITS);
  if (kind === "experience" && trait !== "fact") {
    throw new ValidationError("experience assets must use trait fact");
  }

  const content = requireString(record.content, "content");
  const contentMax =
    kind === "relationship" ? LIMITS.relationshipContentMaxCodePoints : LIMITS.experienceContentMaxCodePoints;
  if (codePoints(content) > contentMax) {
    throw new ValidationError(`content exceeds ${contentMax} code points`);
  }

  const applicability = requireString(record.applicability, "applicability");
  if (codePoints(applicability) > LIMITS.applicabilityMaxCodePoints) {
    throw new ValidationError(`applicability exceeds ${LIMITS.applicabilityMaxCodePoints} code points`);
  }

  if (!Array.isArray(record.tags)) throw new ValidationError("tags must be an array");
  if (record.tags.length > LIMITS.tagsMax) throw new ValidationError(`tags exceeds ${LIMITS.tagsMax} items`);
  const tags = record.tags.map((tag) => {
    if (typeof tag !== "string" || codePoints(tag) > LIMITS.tagMaxCodePoints) {
      throw new ValidationError(`each tag must be a string of at most ${LIMITS.tagMaxCodePoints} code points`);
    }
    return tag;
  });

  const evidence = requireEnum(record.evidence, "evidence", EVIDENCES);
  const verification = requireEnum(record.verification, "verification", VERIFICATIONS);
  const sensitivity = requireEnum(record.sensitivity, "sensitivity", SENSITIVITIES);

  if (record.source === null || typeof record.source !== "object" || Array.isArray(record.source)) {
    throw new ValidationError("source must be an object");
  }
  const sourceRecord = record.source as Record<string, unknown>;
  for (const key of Object.keys(sourceRecord)) {
    if (!(SOURCE_FIELDS as readonly string[]).includes(key)) {
      throw new ValidationError(`unexpected source field: ${key}`);
    }
  }

  const runtime_kind = requireEnum(sourceRecord.runtime_kind, "source.runtime_kind", SUBMITTABLE_RUNTIME_KINDS);
  const session_ref = requireString(sourceRecord.session_ref, "source.session_ref");
  const event_ref = requireString(sourceRecord.event_ref, "source.event_ref");
  if (event_ref.length === 0) throw new ValidationError("source.event_ref must be non-empty");
  if (codePoints(event_ref) > LIMITS.eventRefMaxCodePoints) {
    throw new ValidationError(`source.event_ref exceeds ${LIMITS.eventRefMaxCodePoints} code points`);
  }
  const occurred_at = requireString(sourceRecord.occurred_at, "source.occurred_at");
  if (Number.isNaN(Date.parse(occurred_at))) {
    throw new ValidationError("source.occurred_at must be an ISO 8601 timestamp");
  }

  // Raw-envelope fields are also rejected by the whitelist above; this stays as a
  // defense-in-depth guard for any future key additions.
  assertNoRawEnvelope(record);

  const source: AssetSource = {
    runtime_kind,
    session_ref,
    event_ref,
    occurred_at,
  };

  return { kind, trait, content, applicability, tags, evidence, verification, sensitivity, source };
}
