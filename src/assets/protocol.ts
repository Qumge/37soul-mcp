/**
 * Shared soul-assets/v1 protocol types, fixed enums and limits.
 *
 * These mirror the frozen contract (docs/superpowers/specs/2026-10-20-persistent-soul-contract-v1.md).
 * DTO field names keep the wire snake_case so the objects can round-trip to the
 * HTTP API unchanged; function parameters that only exist inside the local
 * selector use camelCase (see ContextInput). This file is deliberately separate
 * from the legacy TranscriptUpload types in src/agentd — the old raw-transcript
 * upload protocol is isolated and must not be reused for assets.
 */
import { createHash } from "node:crypto";

// --- Fixed enums -----------------------------------------------------------------

/** The four local install targets. Web/legacy appear only in Asset.source.runtime_kind. */
export type RuntimeKind = "claude-code" | "codex" | "opencode" | "hermes";
export const RUNTIME_KINDS = ["claude-code", "codex", "opencode", "hermes"] as const;

/** Readonly runtime_kind values accepted on a cloud Asset.source. */
export type AssetSourceRuntimeKind = RuntimeKind | "web" | "legacy";

export type AssetKind = "relationship" | "experience";
export const ASSET_KINDS = ["relationship", "experience"] as const;

export type AssetTrait = "fact" | "event" | "preference" | "promise";
export const ASSET_TRAITS = ["fact", "event", "preference", "promise"] as const;

export type AssetState = "candidate" | "active" | "rejected" | "superseded" | "deleted";
export const ASSET_STATES = ["candidate", "active", "rejected", "superseded", "deleted"] as const;

/** Invalidated states that form a digest tombstone and suppress same-content assets. */
export const ASSET_TOMBSTONE_STATES = ["rejected", "superseded", "deleted"] as const;

export type Evidence = "explicit_user_statement" | "inference" | "observed_result";
export const EVIDENCES = ["explicit_user_statement", "inference", "observed_result"] as const;

export type Verification = "unverified" | "confirmed";
export const VERIFICATIONS = ["unverified", "confirmed"] as const;

export type Sensitivity = "normal" | "sensitive";
export const SENSITIVITIES = ["normal", "sensitive"] as const;

export type ConsentCategory = "identity" | "relationship" | "experience";
export const CONSENT_CATEGORIES = ["identity", "relationship", "experience"] as const;

export type BindingState = "bound" | "detached";
export const BINDING_STATES = ["bound", "detached"] as const;

// --- Limits ----------------------------------------------------------------------

export const LIMITS = {
  /** Context byte budget range (§7). */
  budgetMin: 128,
  budgetMax: 16384,
  /** The identity section is capped at min(8192, budget). */
  identityBudgetMax: 8192,
  /** Selection caps (§7). */
  relationshipMax: 8,
  experienceMax: 4,
  relevanceWordsMax: 32,
  /** Content length limits in Unicode code points (§2.3). */
  relationshipContentMaxCodePoints: 200,
  experienceContentMaxCodePoints: 4000,
  applicabilityMaxCodePoints: 500,
  tagsMax: 8,
  tagMaxCodePoints: 32,
  eventRefMaxCodePoints: 128,
  /** Identity field limits in Unicode code points (§4). */
  identityNameMaxCodePoints: 80,
  identityDescriptionMaxCodePoints: 1000,
  identityCharacterMaxCodePoints: 8000,
  identityGreetingMaxCodePoints: 1000,
  /** Push batch limits (§5). */
  pushMaxChanges: 50,
  pushMaxBytes: 256 * 1024,
} as const;

// --- Objects ---------------------------------------------------------------------

export interface Identity {
  name: string;
  description: string;
  character: string;
  greeting: string;
  /** Optional for legacy snapshots; required by the new create/registration flow. */
  sex?: "male" | "female" | "other";
  age?: number;
}

export interface Soul {
  soul_uid: string;
  legacy_host_id: number | null;
  identity_revision: number;
  identity: Identity;
  /** The contract only pins "active" today; widened by later tasks if a new state is added. */
  state: "active";
  /** Local-only provenance: never sent over the wire. */
  origin?: "local" | "cloud";
  /** Local-only original identity, preserved when a cloud identity is revoked. */
  local_identity?: Identity;
  /** Local-only revision of the original identity (never reset to 1 on restore). */
  local_identity_revision?: number;
  /** New-client public intent; absent means a legacy/private local Soul. */
  publish_profile?: boolean;
  /** Canonical server/default avatar URL when known. Never a local path. */
  avatar_url?: string;
  /** User-selected local image path; local-only until an authorized upload. */
  local_avatar_path?: string;
  /** True only after the cloud accepted the chosen image. */
  avatar_uploaded?: boolean;
}

export interface Binding {
  binding_uid: string;
  session_ref: string;
  runtime_kind: RuntimeKind;
  soul_uid: string;
  revision: number;
  state: BindingState;
  /** Local-only: last server-confirmed revision (never sent over the wire). */
  cloud_revision?: number | null;
  /** Local-only: this binding has an unconfirmed local mutation. */
  unconfirmed?: boolean;
}

export interface Consent {
  cloud_device_uid: string;
  soul_uid: string;
  revision: number;
  categories: ConsentCategory[];
  enabled: boolean;
}

export interface AssetSource {
  runtime_kind: AssetSourceRuntimeKind;
  session_ref: string;
  event_ref: string;
  occurred_at: string;
}

export interface Asset {
  asset_uid: string;
  soul_uid: string;
  kind: AssetKind;
  trait: AssetTrait;
  content: string;
  applicability: string;
  tags: string[];
  evidence: Evidence;
  verification: Verification;
  sensitivity: Sensitivity;
  state: AssetState;
  revision: number;
  supersedes_uid: string | null;
  pinned: boolean;
  source: AssetSource;
  /** Server-generated digest; absent on local-only assets that never reached the cloud. */
  content_digest?: string;
  /** Present on invalidated (tombstone) records; null until an explicit restore points at it. */
  restored_by_uid?: string | null;
}

/** The fixed 8-field tombstone: no body, never re-sends deleted/superseded/rejected content. */
export interface AssetTombstone {
  asset_uid: string;
  soul_uid: string;
  kind: AssetKind;
  trait: AssetTrait;
  content_digest: string;
  revision: number;
  state: AssetState;
  restored_by_uid: string | null;
}

/** The propose payload: an asset without server-generated identity/state fields. */
export interface ProposedAsset {
  kind: AssetKind;
  trait: AssetTrait;
  content: string;
  applicability: string;
  tags: string[];
  evidence: Evidence;
  verification: Verification;
  sensitivity: Sensitivity;
  source: AssetSource;
}

export type ChangeOperation = "propose" | "review" | "delete";

export interface Change {
  change_id: string;
  operation: ChangeOperation;
  soul_uid: string;
  asset_uid: string;
  base_revision: number;
  actor: "model" | "owner";
  binding_uid: string | null;
  binding_revision: number | null;
  /** Operation-specific payload; propose payloads are validated by validateProposedAsset. */
  payload: Record<string, unknown>;
}

export type PushResultStatus = "accepted" | "duplicate" | "conflict" | "rejected";
export type ObjectType = "soul" | "binding" | "asset" | "consent";

export interface AppliedRevision {
  object_uid: string;
  revision: number;
}

export interface WrappedObject {
  object_type: ObjectType;
  object: Record<string, unknown>;
}

export interface PushError {
  code: string;
  message?: string;
  retryable?: boolean;
  current_revision?: number;
}

export interface PushResult {
  change_id: string;
  status: PushResultStatus;
  applied_revisions?: AppliedRevision[];
  objects?: WrappedObject[];
  canonical_asset_uid?: string;
  error: PushError | null;
}

export interface PushResponse {
  protocol: "soul-assets/v1";
  results: PushResult[];
}

export interface PullEvent {
  event_uid: string;
  object_type: ObjectType;
  object: Record<string, unknown>;
}

export interface PullPage {
  protocol: "soul-assets/v1";
  events: PullEvent[];
  next_cursor: string | null;
  has_more: boolean;
}

// --- Context selector I/O ----------------------------------------------------------

export interface ContextInput {
  soul: Soul;
  assets: readonly (Asset | AssetTombstone)[];
  taskHint: string;
  budgetBytes?: number;
  binding: Binding;
  /** UIDs of unconfirmed local proposals to quarantine; never a confirmed cloud copy. */
  quarantinedAssetUids?: readonly string[];
}

export interface ContextManifestEntry {
  asset_uid: string;
  revision: number;
}

export interface ContextBundle {
  soul_uid: string;
  identity_revision: number;
  binding_uid: string;
  binding_revision: number;
  manifest: ContextManifestEntry[];
  rendered_text: string;
  truncated: boolean;
}

// --- Helpers -----------------------------------------------------------------------

/** Count Unicode code points (surrogate pairs count once). */
export function codePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * The server-side content_digest: NFC, trim leading/trailing ASCII space/tab/CR/LF,
 * then UTF-8 SHA-256 (lowercase hex). Case is preserved.
 */
export function contentDigest(content: string): string {
  const nfc = content.normalize("NFC");
  const trimmed = nfc.replace(/^[\x20\t\r\n]+|[\x20\t\r\n]+$/g, "");
  return createHash("sha256").update(trimmed, "utf8").digest("hex");
}
