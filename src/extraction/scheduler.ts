import {observeCodexBinding, freshCodexBoundary} from '../agentd/codex-native.js';
import {canReserve,reserve} from './resource-budget.js';
import {rememberPendingSessionSource} from "../agentd/session-source-hints.js";
/**
 * Task 4: bounded extraction scheduling.
 *
 * Runtime events become bounded extraction jobs that produce candidate portable
 * assets, never raw text. The invariants:
 *
 *   - A source range is extracted at most MAX_AUTO_ATTEMPTS (2) times per binding
 *     revision. `pending` is written at schedule time and only the commit may
 *     write `completed`; a crash leaves `pending` and the range retries at the
 *     next applicable checkpoint.
 *   - A retry never happens in an immediate loop: it only occurs at the next
 *     applicable checkpoint (turn_completed / checkpoint / explicit_feedback) or
 *     an explicit retry call (`drainPendingExtractions`).
 *   - Internal events (model messages / subtasks / Stop carrying the job uid) are
 *     excluded by `isInternalEvent` and can never schedule another job.
 *   - The commit re-asserts the binding is still current (`assertBindingCurrent`)
 *     before touching anything, so a result frozen at an old revision can never
 *     be applied over a switched/detached session. Asset + watermark + outbox
 *     land in one `store.transact`.
 *   - Raw source is never read here: the adapter receives only source *refs*.
 *
 * Single-writer: the model call runs here (the worker), but every store write goes
 * through a writer command (`begin_extraction` / `commit_extraction` /
 * `fail_extraction`), so it serializes with bind/detach in the writer process.
 * When no writer is listening, the command is resent through a transient
 * in-process writer started under the same writer lock — there is never a lockless
 * snapshot write from a non-writer process. The writer never waits on a model call.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import type {
  BindingSnapshot,
  PreparedExtraction,
  ExtractionRequest,
  ExtractionResult,
  RuntimeAdapter,
  RuntimeEvent,
  SourceRange,
} from "../adapters/types.js";
import { contentDigest, type AssetSource, type ProposedAsset } from "../assets/protocol.js";
import { VALIDATION_REJECTION_REASONS, ValidationError, type ValidationRejectionCounts, classifyProposalState, validateProposedAsset } from "../assets/validation.js";
import { captureSourcePointer, isSourceWindowIdentity, loadSourcePointer, pendingSourceCaptures, readObservedSourceWindow, MAX_SOURCE_BYTES, sourceMatchesBoundary, extractTranscriptPath, isSafeEventRef, isSafeProfileId, validateTranscriptPath } from "../agentd/source-index.js";
import { hostSpec } from "../hosts/registry.js";
import type { ExtractionDiagnostic } from "../adapters/types.js";
import {
  defaultStoreFs,
  openStore,
  profilesDir,
  StoreError,
  type ExtractionWatermark,
  type LocalAsset,
  type OutboxOperation,
  type StoreFs,
  type StoreSnapshot,
} from "../local/store.js";
import { assertBindingCurrent, bindingKey, resolveBinding } from "../local/bindings.js";
import { resolveRoot } from "../local/profiles.js";
import { registerWriterCommand, sendWriter, startWriter, type WriterResult } from "../local/writer.js";
import {
  getInternalJob,
  isInternalEvent,
  registerInternalJob,
  unregisterInternalJob,
} from "./internal-tasks.js";

export { isInternalEvent };

/** The automatic attempt budget per source range per binding revision. */
export const MAX_AUTO_ATTEMPTS = 2;

/** The runtime events that may trigger an extraction attempt. */
export const APPLICABLE_EVENT_KINDS: readonly RuntimeEvent["kind"][] = [
  "turn_completed",
  "checkpoint",
  "explicit_feedback",
];

export interface ExtractionOptions {
  root: string;
  adapter: RuntimeAdapter;
  fs?: Partial<StoreFs>;
}

export interface RunOptions {
  diagnostic?: (counts: ExtractionDiagnostic) => void;
  root?: string;
  fs?: Partial<StoreFs>;
}

/**
 * Watermark key: native session id + source range + binding revision, so a new
 * binding version gets a fresh 2-attempt budget while old keys stay for trace.
 */
export function watermarkKey(binding: BindingSnapshot, range: SourceRange): string {
  return `${binding.native_session_id}#${range.start}-${range.end}#rev${binding.revision}`;
}

function freezeRequest(binding: BindingSnapshot, range: SourceRange, jobUid: string): ExtractionRequest {
  return {
    job_uid: jobUid,
    runtime_kind: binding.runtime_kind,
    native_session_id: binding.native_session_id,
    source_event_refs: range.event_refs.slice(),
    ...(range.turn_refs !== undefined ? { source_turn_refs: range.turn_refs.slice() } : {}),
    binding_uid: binding.binding_uid,
    binding_revision: binding.revision,
    soul_uid: binding.soul_uid,
    internal_task: true,
  };
}

/** A deterministic, non-negative interval id for a set of source event refs. */
function refsDigest(refs: readonly string[]): number {
  // FNV-1a 32-bit over the sorted, joined refs (a separator between refs). Stable
  // across runs and processes; collisions only share an attempt budget, never leak.
  let hash = 0x811c9dc5;
  for (const ref of [...refs].sort()) {
    for (let i = 0; i < ref.length; i += 1) {
      hash ^= ref.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
  }
  return hash >>> 0;
}

/**
 * A single-event range. Without session stream indices (Task 6+) the interval is
 * derived from the event refs themselves so disjoint events get disjoint ranges —
 * and therefore independent attempt budgets — instead of every event collapsing
 * onto the same `start=0,end=0` budget for the whole session.
 */
export function rangeForEvent(event: RuntimeEvent): SourceRange {
  // Use the actual host turn ids for the stable watermark interval when present.
  // The random event_ref remains the source-pointer key, so repetitive Stop/
  // SessionEnd events for the same turn share one budget instead of re-extracting.
  const turnRefs = event.source_turn_refs !== undefined ? event.source_turn_refs.slice() : null;
  const interval = refsDigest(turnRefs && turnRefs.length > 0 ? turnRefs : [event.event_ref]);
  return { event_refs: [event.event_ref], start: interval, end: interval, ...(turnRefs !== null ? { turn_refs: turnRefs } : {}) };
}

function openFs(options: { fs?: Partial<StoreFs> }): StoreFs {
  return { ...defaultStoreFs, ...(options.fs ?? {}) };
}

/**
 * Schedule one attempt for a binding + range, then run it in-process. Idempotent:
 * an already-completed range is a no-op, and an exhausted budget refuses to run
 * without touching the model or the counter.
 */
export async function scheduleExtraction(
  binding: BindingSnapshot,
  range: SourceRange,
  options: ExtractionOptions,
): Promise<void> {
  const root = resolveRoot(options.root);
  const jobUid = randomUUID();
  const request = freezeRequest(binding, range, jobUid);

  const begin = await beginExtraction(root, binding, range, jobUid);
  if (!begin.scheduled) return;

  registerInternalJob({ jobUid, root, profileId: binding.profile_id, binding, range, request });
  try {
    await runExtraction(jobUid, options.adapter, { root });
  } finally {
    unregisterInternalJob(jobUid);
  }
}

/**
 * Run an already-registered extraction job: invoke the adapter, then commit. On a
 * model error the watermark records `error` (never `completed`); on a stale
 * binding the commit is refused and the range is marked failed — it can never be
 * applied over the current binding.
 */
export async function runExtraction(
  jobUid: string,
  adapter: RuntimeAdapter,
  options: RunOptions = {},
): Promise<ExtractionResult> {
  const job = getInternalJob(jobUid);
  if (!job) throw new StoreError("unknown_job", `no extraction job ${jobUid}`);
  const root = options.root ? resolveRoot(options.root) : job.root;
  const key = watermarkKey(job.binding, job.range);

  let result: ExtractionResult;
  try {
    result = await adapter.extract(job.request);
  } catch {
    result = { error: { code: "adapter_failed", retryable: true } };
  }

  if ("error" in result) {
    await failExtraction(root, job.profileId, key, result.error.code);
    return result;
  }

  const counts = await commitResult(root, job.binding, job.range, result.proposals);
  for (const diagnostic of counts) options.diagnostic?.(diagnostic);
  return result;
}

// --- write paths: every snapshot write goes through the single writer --------------

type ExtractionCommand = "observe_codex" | "defer_extraction" | "reserve_extraction_batch" | "begin_extraction" | "commit_extraction" | "fail_extraction" | "resolve_source_capture";

/**
 * Send a writer command, retrying through a transient in-process writer when no
 * writer is listening (mirrors cli.ts `runWriterCommand`). On `writer_unavailable`
 * we acquire the writer lock via `startWriter` and resend — never a lockless
 * snapshot write. If another writer already holds the lock but is not yet
 * listening, `startWriter` fails and we retry the send once more; the operation
 * then fails loudly instead of writing around the lock.
 */
async function sendWriterCommand(
  root: string,
  profileId: string,
  command: ExtractionCommand,
  payload: Record<string, unknown>,
): Promise<WriterResult> {
  const request = { request_uid: randomUUID(), profile_id: profileId, command, payload };
  const direct = await sendWriter(root, request);
  if (direct.ok || direct.error.code !== "writer_unavailable") return direct;
  const writer = await startWriter(root).catch(() => null);
  if (!writer) return sendWriter(root, request); // lock held but not yet listening
  try {
    return await sendWriter(root, request);
  } finally {
    await writer.close().catch(() => {});
  }
}

async function beginExtraction(
  root: string,
  binding: BindingSnapshot,
  range: SourceRange,
  jobUid: string,
): Promise<{ scheduled: boolean; reason?: string }> {
  const result = await sendWriterCommand(root, binding.profile_id, "begin_extraction", {
    binding,
    range,
    job_uid: jobUid,
  });
  if (!result.ok) return { scheduled: false, reason: result.error.code };
  const value = (result.result ?? {}) as { scheduled?: boolean };
  return { scheduled: value.scheduled === true };
}

async function commitResult(
  root: string,
  binding: BindingSnapshot,
  range: SourceRange,
  proposals: ProposedAsset[],
): Promise<ExtractionDiagnostic[]> {
  const result = await sendWriterCommand(root, binding.profile_id, "commit_extraction", {
    binding,
    range,
    proposals,
  });
  if (!result.ok) throw new StoreError(result.error.code, result.error.message);
  const value = result.result as {diagnostic?: ExtractionDiagnostic; rejections?: ValidationRejectionCounts};
  return [
    ...(value?.diagnostic ? [value.diagnostic] : []),
    ...(value?.rejections && Object.keys(value.rejections).length > 0 ? [{stage: "reject" as const, reasons: value.rejections}] : []),
  ];
}

async function failExtraction(
  root: string,
  profileId: string,
  key: string,
  code: string,
): Promise<void> {
  // Best-effort failure record: a refused write never fails the working session.
  await sendWriterCommand(root, profileId, "fail_extraction", { watermark_key: key, error_code: code });
}

/** Lifecycle enqueue: write one pending range without spending a model attempt. */
async function enqueueExtractionDirect(
  root: string,
  binding: BindingSnapshot,
  range: SourceRange,
  jobUid: string,
  fs: StoreFs,
): Promise<{ scheduled: boolean; reason?: string }> {
  const key = watermarkKey(binding, range);
  const store = await openStore(root, binding.profile_id, { fs });
  try {
    const snap = await store.read();
    if (!isCurrentBinding(snap, binding)) return { scheduled: false, reason: "stale_binding" };
    const existing = snap.extraction_watermarks[key];
    if (existing?.completed) return { scheduled: false, reason: "completed" };
    if (existing) {
      // Stop/SessionEnd for the same host turn are lifecycle duplicates. Pending,
      // running and failed ranges are already owned by the worker/retry path.
      return { scheduled: false, reason: "duplicate_turn" };
    }
    await store.transact((draft) => {
      draft.extraction_watermarks[key] = {
        completed: false,
        attempts: 0,
        state: "pending",
        last_error: null,
        claimed_at: null,
        queued_at: new Date().toISOString(),
        request: freezeRequest(binding, range, jobUid),
      };
    });
    return { scheduled: true };
  } finally {
    await store.close();
  }
}

/** Worker claim: atomically transition pending/error (or a stale running claim) to
 *  running and consume exactly one of the two model attempts. */
async function claimExtractionDirect(
  root: string,
  binding: BindingSnapshot,
  range: SourceRange,
  jobUid: string,
  fs: StoreFs,
): Promise<{ scheduled: boolean; reason?: string }> {
  const key = watermarkKey(binding, range);
  const store = await openStore(root, binding.profile_id, { fs });
  try {
    const snap = await store.read();
    if (!isCurrentBinding(snap, binding)) return { scheduled: false, reason: "stale_binding" };
    const existing = snap.extraction_watermarks[key];
    if (existing && (existing.request.binding_uid !== binding.binding_uid ||
        existing.request.binding_revision !== binding.revision || existing.request.soul_uid !== binding.soul_uid)) {
      return { scheduled: false, reason: "stale_binding" };
    }
    if (existing?.completed) return { scheduled: false, reason: "completed" };
    if (existing) {
      if (existing.attempts >= MAX_AUTO_ATTEMPTS) return { scheduled: false, reason: "budget_exhausted" };
      if (existing.state === "running") {
        const claimedAt = existing.claimed_at ? Date.parse(existing.claimed_at) : NaN;
        const stale = !Number.isFinite(claimedAt) || Date.now() - claimedAt > 10 * 60 * 1000;
        if (!stale) return { scheduled: false, reason: "claimed" };
      }
    }
    await store.transact((draft) => {
      const prior = draft.extraction_watermarks[key];
      const attempts = (prior?.attempts ?? 0) + 1;
      draft.extraction_watermarks[key] = {
        completed: false,
        attempts,
        state: "running",
        last_error: prior?.last_error ?? null,
        claimed_at: new Date().toISOString(),
        request: freezeRequest(binding, range, jobUid),
      };
    });
    return { scheduled: true };
  } finally {
    await store.close();
  }
}

async function recordFailure(
  root: string,
  profileId: string,
  key: string,
  code: string,
  fs: StoreFs,
): Promise<void> {
  const store = await openStore(root, profileId, { fs });
  try {
    await store.transact((draft) => {
      const wm = draft.extraction_watermarks[key];
      if (!wm) return;
      draft.extraction_watermarks[key] = { ...wm, completed: false, state: "error", last_error: code };
    });
  } finally {
    await store.close();
  }
}

/**
 * The single atomic commit: re-assert the binding is current, then validate +
 * classify every proposal and write asset + watermark + outbox in one transact.
 * A stale binding records `stale_binding` on the watermark and never commits.
 */
async function commitExtraction(
  root: string,
  binding: BindingSnapshot,
  range: SourceRange,
  proposals: ProposedAsset[],
  fs: StoreFs,
): Promise<{ committed: boolean; reason?: string; diagnostic?: ExtractionDiagnostic; rejections?: ValidationRejectionCounts }> {
  const key = watermarkKey(binding, range);

  let current = true;
  try {
    await assertBindingCurrent(binding, binding.binding_uid, binding.revision, { root, fs });
  } catch (error) {
    if (error instanceof StoreError && (error.code === "stale_binding" || error.code === "unknown_binding")) {
      current = false;
    } else {
      throw error;
    }
  }
  if (!current) {
    await recordFailure(root, binding.profile_id, key, "stale_binding", fs);
    return { committed: false, reason: "stale_binding" };
  }

  const store = await openStore(root, binding.profile_id, { fs });
  try {
    const snap = await store.read();
    const assets: LocalAsset[] = [];
    const ops: OutboxOperation[] = [];
    const rejections: ValidationRejectionCounts = {};

    for (const raw of proposals) {
      let proposal: ProposedAsset;
      try {
        proposal = validateProposedAsset(raw);
      } catch (error) {
        const reason = error instanceof ValidationError && VALIDATION_REJECTION_REASONS.includes(error.reason) ? error.reason : "unknown";
        rejections[reason] = (rejections[reason] ?? 0) + 1;
        continue; // preserve rejection policy; only fixed-label counts may leave here
      }
      const blockedByTombstone = tombstoneHit(snap, proposal);
      const state = classifyProposalState(proposal, { blockedByTombstone });
      const authorized = consentAuthorized(snap, binding.soul_uid, proposal.kind);
      const asset = toLocalAsset(proposal, binding, state, authorized);
      assets.push(asset);
      if (authorized) ops.push(assetProposeOp(asset, binding));
    }

    await store.transact((draft) => {
      for (const asset of assets) draft.assets[asset.asset_uid] = asset;
      for (const op of ops) draft.outbox[op.operation_id] = op;
      const wm = draft.extraction_watermarks[key];
      draft.extraction_watermarks[key] = {
        completed: true,
        attempts: wm?.attempts ?? 0,
        state: "completed",
        last_error: null,
        request: wm?.request ?? freezeRequest(binding, range, randomUUID()),
      };
    });
    return { committed: true, rejections, diagnostic: {stage: "commit", proposals_received: proposals.length, proposals_accepted: assets.length, proposals_rejected: proposals.length - assets.length, proposals_queued: ops.length} };
  } finally {
    await store.close();
  }
}

function tombstoneHit(snap: StoreSnapshot, proposal: ProposedAsset): boolean {
  const digest = contentDigest(proposal.content);
  for (const list of Object.values(snap.digest_tombstones)) {
    for (const tombstone of list) {
      if (tombstone.content_digest === digest) return true;
    }
  }
  return false;
}

function consentAuthorized(
  snap: StoreSnapshot,
  soulUid: string,
  category: ProposedAsset["kind"],
): boolean {
  for (const consent of Object.values(snap.consents)) {
    if (consent.soul_uid !== soulUid || !consent.enabled) continue;
    if ((consent.categories as readonly string[]).includes(category)) return true;
  }
  return false;
}

function toLocalAsset(
  proposal: ProposedAsset,
  binding: BindingSnapshot,
  state: "active" | "candidate",
  authorized: boolean,
): LocalAsset {
  return {
    asset_uid: randomUUID(),
    soul_uid: binding.soul_uid,
    kind: proposal.kind,
    trait: proposal.trait,
    content: proposal.content,
    applicability: proposal.applicability,
    tags: proposal.tags.slice(),
    evidence: proposal.evidence,
    verification: proposal.verification,
    sensitivity: proposal.sensitivity,
    state,
    revision: 1,
    supersedes_uid: null,
    pinned: false,
    source: pinnedSource(proposal, binding),
    sync_state: authorized ? "pending_sync" : "local_only",
    cloud_revision: null,
    binding_uid: binding.binding_uid,
    binding_revision: binding.revision,
  };
}

/** Source metadata is pinned to the binding: never the model's claimed session. */
function pinnedSource(proposal: ProposedAsset, binding: BindingSnapshot): AssetSource {
  return {
    runtime_kind: binding.runtime_kind,
    session_ref: binding.session_ref,
    event_ref: proposal.source.event_ref,
    occurred_at: proposal.source.occurred_at,
  };
}

function assetProposeOp(asset: LocalAsset, binding: BindingSnapshot): OutboxOperation {
  return {
    operation_id: asset.asset_uid,
    operation_kind: "asset",
    request: {
      change_id: asset.asset_uid,
      operation: "propose",
      soul_uid: asset.soul_uid,
      asset_uid: asset.asset_uid,
      base_revision: 0,
      actor: "model",
      binding_uid: binding.binding_uid,
      binding_revision: binding.revision,
      payload: {
        kind: asset.kind,
        trait: asset.trait,
        content: asset.content,
        applicability: asset.applicability,
        tags: asset.tags,
        evidence: asset.evidence,
        verification: asset.verification,
        sensitivity: asset.sensitivity,
        source: asset.source,
      },
    },
    predecessor_operation_ids: [],
  };
}

/**
 * The event → schedule bridge (worker path). Internal events, non-applicable kinds
 * and sessions without a binding never schedule a job.
 */
export async function handleRuntimeEvent(
  event: RuntimeEvent,
  options: ExtractionOptions,
): Promise<{ scheduled: boolean; reason?: string; jobUid?: string }> {
  if (isInternalEvent(event)) return { scheduled: false, reason: "internal" };
  // Resolve (and, for a first session, create) the native-session binding even for
  // non-extractable lifecycle events. SessionStart/UserPromptSubmit are exactly
  // where the hook must see that binding before injecting context; only the
  // extraction scheduling below is limited to applicable completed-turn events.
  const binding = await resolveBinding(event.key, undefined, { root: options.root, fs: options.fs });
  if (!binding) return { scheduled: false, reason: "no_binding" };
  if (!(APPLICABLE_EVENT_KINDS as readonly string[]).includes(event.kind)) {
    return { scheduled: false, reason: "not_applicable" };
  }
  await scheduleExtraction(binding, rangeForEvent(event), options);
  return { scheduled: true };
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const key = record.key;
  if (key === null || typeof key !== "object" || Array.isArray(key)) return false;
  const k = key as Record<string, unknown>;
  return (
    typeof record.event_ref === "string" &&
    record.event_ref.length > 0 &&
    typeof record.kind === "string" &&
    (record.internal_job_uid === null || typeof record.internal_job_uid === "string") &&
    typeof k.profile_id === "string" &&
    typeof k.device_id === "string" &&
    typeof k.runtime_kind === "string" &&
    typeof k.native_session_id === "string"
  );
}

function isBindingSnapshot(value: unknown): value is BindingSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.binding_uid === "string" &&
    typeof r.session_ref === "string" &&
    typeof r.runtime_kind === "string" &&
    typeof r.soul_uid === "string" &&
    typeof r.revision === "number" &&
    typeof r.state === "string" &&
    typeof r.profile_id === "string" &&
    typeof r.device_id === "string" &&
    typeof r.native_session_id === "string"
  );
}

function isSourceRange(value: unknown): value is SourceRange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Array.isArray(r.event_refs) &&
    r.event_refs.every((ref) => typeof ref === "string") &&
    typeof r.start === "number" &&
    typeof r.end === "number"
  );
}

// --- writer commands (registered at module top level) ------------------------------

/**
 * The hook's assets-mode emission channel. The writer only validates, resolves the
 * binding and writes a `pending` watermark — it never waits on a model call. The
 * worker process picks the pending job up through `drainPendingExtractions`.
 */
/** The observer reads bound sources only, inside the same writer FIFO as detach/rebind. */
const codexObserverRotation = new Map<string, number>();
registerWriterCommand("observe_codex", async ({root, request}) => {
  const profile = request.profile_id;
  const store = await openStore(root, profile);
  let bindings: BindingSnapshot[];
  try {
    const snap = await store.read();
    bindings = Object.values(snap.bindings).filter(b => {
      const consent = snap.consents[`${snap.cloud_device_uid}:${b.soul_uid}`];
      return b.source_mode === "codex-native" && b.runtime_kind === "codex" && isCurrentBinding(snap, b);
    });
  } finally {await store.close();}
  let scheduled = 0;
  const rotationKey = root + "\0" + profile;
  const offset = (codexObserverRotation.get(rotationKey) ?? 0) % (bindings.length || 1);
  const selected = [...bindings.slice(offset), ...bindings.slice(0, offset)].slice(0, 16);
  codexObserverRotation.set(rotationKey, offset + selected.length);
  for (const binding of selected) {
    const consentStore = await openStore(root, profile); let consent;
    try {const snap = await consentStore.read(); consent = snap.consents[`${snap.cloud_device_uid}:${binding.soul_uid}`];}
    finally {await consentStore.close();}
    const authorized = consent?.enabled && consent.categories.includes("identity") && consent.categories.some(c => c === "relationship" || c === "experience");
    if (!authorized && binding.codex_capture_paused) continue;
    if (!authorized || binding.codex_capture_paused || (binding.codex_consent_revision !== undefined && binding.codex_consent_revision !== consent?.revision)) {
      const boundary = authorized ? await freshCodexBoundary(binding) : null;
      const update = await openStore(root, profile);
      try {await update.transact(d => {
        if (!isCurrentBinding(d, binding)) return;
        const current = d.bindings[bindingKey(binding)]; current.codex_capture_paused = !authorized || !boundary;
        if (boundary) {current.source_boundary = boundary; current.codex_cursor = {offset: boundary.start_offset, size: boundary.start_offset, discard_line: !boundary.starts_line}; current.codex_consent_revision = consent!.revision;}
      });} finally {await update.close();}
      continue;
    }
    const observed = await observeCodexBinding(binding);
    if (!observed) continue;
    for (const completed of observed.completed) {
      const digest = createHash("sha256").update(JSON.stringify([binding.binding_uid, binding.revision, completed.ref])).digest("hex");
      const ref = `${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;
      await captureSourcePointer(root, profile, ref, {runtime_kind: "codex", native_session_id: binding.native_session_id, path: binding.source_boundary!.path, captured_at: new Date().toISOString(), end_offset: completed.window.end, source_boundary: binding.source_boundary, frozen_window: completed.window});
      const event: RuntimeEvent = {key: binding, event_ref: ref, kind: "turn_completed", source_turn_refs: [completed.ref], internal_job_uid: null};
      const result = await enqueueExtractionDirect(root, binding, rangeForEvent(event), randomUUID(), defaultStoreFs);
      if (result.scheduled) scheduled++;
    }
    if (JSON.stringify(binding.codex_cursor) !== JSON.stringify(observed.cursor)) {
      const currentStore = await openStore(root, profile);
      try {await currentStore.transact(d => {if (isCurrentBinding(d, binding)) d.bindings[bindingKey(binding)].codex_cursor = observed.cursor;});}
      finally {await currentStore.close();}
    }
  }
  return {scheduled};
});

registerWriterCommand("runtime_event", async ({ root, request }) => {
  const event = request.payload.event;
  if (!isRuntimeEvent(event)) {
    throw new StoreError("invalid_event", "runtime_event payload.event must be a valid RuntimeEvent");
  }
  // The pointer index builds <root>/sources/<profile_id>/<event_ref>.json from these
  // two values: reject anything that could escape that directory before any write.
  if (!isSafeProfileId(event.key.profile_id) || !isSafeEventRef(event.event_ref)) {
    throw new StoreError(
      "invalid_event",
      "runtime_event payload carries an unsafe profile_id or event_ref (must be a path-safe segment; event_ref must be a UUID)",
    );
  }
  if (isInternalEvent(event)) return { scheduled: false, reason: "internal" };

  // Task 10c: record the host's own transcript location as a path pointer for this
  // event ref — path only, never text. Validated here (absolute, existing regular
  // file); runtimes that omit a transcript location are never indexed.
  const binding = await resolveBinding(event.key, undefined, { root });
  if(binding && ["compact","reset","resume"].includes(event.kind)){
    const store=await openStore(root,event.key.profile_id);
    try{await store.transact(d=>{if(isCurrentBinding(d,binding))d.bindings[bindingKey(event.key)].context_epoch=randomUUID();});}
    finally{await store.close();}
  }
  if (event.kind === "compact" || event.kind === "reset") {
    // A lifecycle compaction may preserve/append the old prefix. Still retire its
    // unresolved witnesses; a late flush cannot revive a pre-compaction turn.
    for (const ref of await pendingSourceCaptures(root, event.key.profile_id)) {
      const pointer = await loadSourcePointer(root, event.key.profile_id, ref);
      if (pointer?.turn_capture && pointer.runtime_kind === event.key.runtime_kind && pointer.native_session_id === event.key.native_session_id) {
        pointer.turn_capture.state = "invalid";
        await captureSourcePointer(root, event.key.profile_id, ref, pointer);
      }
    }
  }
  const candidate = extractTranscriptPath(request.payload);
  if (candidate !== null && (event.kind === "resume" || event.kind === "request")) {
    // First-prompt hooks may finish before the host creates its transcript. This
    // metadata cannot become an extraction source; connect validates it later.
    await rememberPendingSessionSource(root, event.key, candidate);
  }
  if (binding?.source_boundary && (candidate === null || !(await sourceMatchesBoundary(candidate, binding.source_boundary)))) {
    // Keep only the new hook's path so an explicit reattach can establish a fresh
    // boundary after compaction. This event must never schedule old source.
    if (candidate !== null && await validateTranscriptPath(candidate)) {
      await captureSourcePointer(root, event.key.profile_id, event.event_ref, {
        runtime_kind: event.key.runtime_kind, native_session_id: event.key.native_session_id,
        path: candidate, captured_at: new Date().toISOString(),
      });
    }
    return {scheduled: false, reason: "source_boundary_unavailable"};
  }
  if (request.payload.completion_capture_required === true) {
    const observation = request.payload.source_observation as {root_ref?: unknown; observed?: unknown} | undefined;
    if (event.kind !== "turn_completed" || !binding || candidate === null || !observation || typeof observation.root_ref !== "string" || observation.root_ref.length === 0 || observation.root_ref.length > 256 || !isSourceWindowIdentity(observation.observed) || !hostSpec(event.key.runtime_kind)?.hook.observeTurn) {
      return {scheduled: false, reason: "completion_source_unavailable"};
    }
    if (!(await validateTranscriptPath(candidate))) return {scheduled: false, reason: "completion_source_unavailable"};
    await captureSourcePointer(root, event.key.profile_id, event.event_ref, {
      runtime_kind: event.key.runtime_kind, native_session_id: event.key.native_session_id,
      path: candidate, captured_at: new Date().toISOString(), end_offset: observation.observed.end,
      ...(binding.source_boundary ? {source_boundary: binding.source_boundary} : {}),
      turn_capture: {root_ref: observation.root_ref, observed: observation.observed,
        binding_uid: binding.binding_uid, binding_revision: binding.revision, session_ref: binding.session_ref, soul_uid: binding.soul_uid,
        device_id: binding.device_id, state: "awaiting"},
    });
    return resolveSourceCaptureDirect(root, event.key.profile_id, event.event_ref);
  }
  if (candidate !== null) {
    const valid = await validateTranscriptPath(candidate);
    if (valid !== null) {
      const rawEnd = (request.payload as Record<string, unknown>).source_end_offset;
      const endOffset = typeof rawEnd === "number" && Number.isSafeInteger(rawEnd) && rawEnd >= 0 ? rawEnd : undefined;
      await captureSourcePointer(root, event.key.profile_id, event.event_ref, {
        runtime_kind: event.key.runtime_kind,
        native_session_id: event.key.native_session_id,
        path: valid,
        captured_at: new Date().toISOString(),
        ...(endOffset !== undefined ? { end_offset: endOffset } : {}),
        ...(binding?.source_boundary ? {source_boundary: binding.source_boundary} : {}),
      }).catch(() => {});
    }
  }

  // Resolve/create the binding for every non-internal lifecycle event. A first
  // SessionStart has no binding yet; the hook awaits this command and then reads
  // that binding to inject. Only completed-turn events schedule extraction.
  if (!binding) return { scheduled: false, reason: "no_binding" };
  if (!(APPLICABLE_EVENT_KINDS as readonly string[]).includes(event.kind)) {
    return { scheduled: false, reason: "not_applicable" };
  }

  const jobUid = randomUUID();
  const result = await enqueueExtractionDirect(root, binding, rangeForEvent(event), jobUid, defaultStoreFs);
  return { ...result, job_uid: jobUid };
});

/** Resolve a Stop witness before a model range exists. All writes are serialized
 * with connect/detach; the original binding is never re-resolved or relabeled.
 * A resolved pointer is durable before enqueue, making a crash between them safe.
 */
async function resolveSourceCaptureDirect(root: string, profile: string, ref: string): Promise<{scheduled: boolean; reason?: string}> {
  const pointer = await loadSourcePointer(root, profile, ref);
  const capture = pointer?.turn_capture;
  if (!pointer || !capture || capture.state === "invalid" || capture.state === "scheduled") return {scheduled: false, reason: "capture_inactive"};
  const store = await openStore(root, profile);
  let binding: BindingSnapshot | undefined;
  try {
    const snap = await store.read();
    binding = findBindingByUid(snap, capture.binding_uid);
    if (binding && (binding.revision !== capture.binding_revision || binding.session_ref !== capture.session_ref || binding.soul_uid !== capture.soul_uid || binding.device_id !== capture.device_id || binding.native_session_id !== pointer.native_session_id || binding.runtime_kind !== pointer.runtime_kind)) binding = undefined;
  } finally { await store.close(); }
  const invalidate = async (reason: string) => {
    capture.state = "invalid";
    await captureSourcePointer(root, profile, ref, pointer);
    return {scheduled: false, reason};
  };
  if (!binding) return invalidate("stale_binding");
  if (capture.state === "awaiting") {
    const window = await readObservedSourceWindow(pointer.path, capture.observed);
    if (!window) return invalidate("source_changed");
    if (binding.source_boundary && !(await sourceMatchesBoundary(pointer.path, binding.source_boundary))) return invalidate("source_changed");
    const turn = hostSpec(pointer.runtime_kind)?.hook.observeTurn?.(window.text, capture.root_ref);
    if (!turn || turn.state === "invalid" || (binding.source_boundary && window.start + turn.root_offset < binding.source_boundary.start_offset)) return invalidate("turn_boundary_unavailable");
    if (turn.state !== "completed" || turn.end_offset === undefined) {
      if (window.end - window.start >= MAX_SOURCE_BYTES) return invalidate("source_window_exhausted");
      return {scheduled: false, reason: "awaiting_completion"};
    }
    const end = window.start + turn.end_offset;
    const bytes = window.bytes.subarray(0, turn.end_offset);
    pointer.end_offset = end;
    pointer.frozen_window = {...window.identity, end, sha256: createHash("sha256").update(bytes).digest("hex")};
    capture.turn_refs = turn.refs.slice();
    capture.state = "resolved";
    await captureSourcePointer(root, profile, ref, pointer);
  }
  if (!capture.turn_refs?.length || !pointer.frozen_window) return invalidate("completion_source_unavailable");
  const event: RuntimeEvent = {key: {profile_id: profile, device_id: capture.device_id, runtime_kind: pointer.runtime_kind, native_session_id: pointer.native_session_id}, event_ref: ref, kind: "turn_completed", source_turn_refs: capture.turn_refs, internal_job_uid: null};
  const result = await enqueueExtractionDirect(root, binding, rangeForEvent(event), randomUUID(), defaultStoreFs);
  capture.state = "scheduled";
  await captureSourcePointer(root, profile, ref, pointer);
  return result;
}

registerWriterCommand("resolve_source_capture", async ({root, request}) => {
  const ref = request.payload.event_ref;
  if (typeof ref !== "string" || !isSafeEventRef(ref) || !isSafeProfileId(request.profile_id)) throw new StoreError("invalid_payload", "resolve_source_capture requires a safe local pointer ref");
  return resolveSourceCaptureDirect(root, request.profile_id, ref);
});

registerWriterCommand("begin_extraction", async ({ root, request }) => {
  const p = request.payload;
  if (!isBindingSnapshot(p.binding) || !isSourceRange(p.range)) {
    throw new StoreError("invalid_payload", "begin_extraction requires a binding and a range");
  }
  const jobUid = typeof p.job_uid === "string" && p.job_uid ? p.job_uid : randomUUID();
  return claimExtractionDirect(root, p.binding, p.range, jobUid, defaultStoreFs);
});

registerWriterCommand("commit_extraction", async ({ root, request }) => {
  const p = request.payload;
  if (!isBindingSnapshot(p.binding) || !isSourceRange(p.range)) {
    throw new StoreError("invalid_payload", "commit_extraction requires a binding and a range");
  }
  const proposals = Array.isArray(p.proposals) ? (p.proposals as ProposedAsset[]) : [];
  return commitExtraction(root, p.binding, p.range, proposals, defaultStoreFs);
});

registerWriterCommand("fail_extraction", async ({ root, request }) => {
  const p = request.payload;
  const profileId = request.profile_id;
  const key = typeof p.watermark_key === "string" ? p.watermark_key : "";
  const code = typeof p.error_code === "string" && p.error_code ? p.error_code : "adapter_failed";
  if (key === "") throw new StoreError("invalid_payload", "fail_extraction requires watermark_key");
  await recordFailure(root, profileId, key, code, defaultStoreFs);
  return { recorded: true };
});

/**
 * Explicit retry / crash recovery: run every not-yet-completed, under-budget
 * watermark in every profile. Reconstructs the job from the frozen request, so it
 * also works for `pending` watermarks written by the writer process (whose registry
 * is a different process). Never runs a model call on an exhausted range.
 */
type PendingJob={binding:BindingSnapshot;range:SourceRange;request:ExtractionRequest;queued_at?:string;attempts?:number};

registerWriterCommand("defer_extraction",async({root,request})=>{
 const binding=request.payload.binding,range=request.payload.range;
 const reasons=["source_input_too_large","source_unavailable","source_preparation_failed","batch_source_unavailable"];
 if(!isBindingSnapshot(binding)||!isSourceRange(range)||binding.profile_id!==request.profile_id)throw new StoreError("invalid_payload","Invalid deferred extraction");
 const reason=typeof request.payload.reason==="string"&&reasons.includes(request.payload.reason)?request.payload.reason:"source_preparation_failed";
 const store=await openStore(root,request.profile_id);
 try{const snap=await store.read(),key=watermarkKey(binding,range),wm=snap.extraction_watermarks[key];
  if(!isCurrentBinding(snap,binding)||!wm||wm.completed||wm.state==="running"||wm.last_error===reason)return {recorded:false};
  await store.transact(d=>{d.extraction_watermarks[key].last_error=reason;});return {recorded:true};
 }finally{await store.close();}
});

registerWriterCommand("reserve_extraction_batch",async({root,request})=>{
 const jobs=request.payload.jobs as PendingJob[];const units=request.payload.reserved_units;
 if(!Array.isArray(jobs)||jobs.length<1||jobs.length>3||typeof units!=="number"||!Number.isSafeInteger(units)||units<1||units>25600||jobs.some(j=>!isBindingSnapshot(j?.binding)||!isSourceRange(j?.range)||j.binding.profile_id!==request.profile_id))throw new StoreError("invalid_payload","Invalid extraction reservation");
 const first=jobs[0].binding;
 if(jobs.some(j=>j.binding.binding_uid!==first.binding_uid||j.binding.revision!==first.revision||j.binding.soul_uid!==first.soul_uid||j.binding.native_session_id!==first.native_session_id||j.binding.runtime_kind!==first.runtime_kind||j.binding.device_id!==first.device_id))throw new StoreError("invalid_payload","A batch must use one exact native binding");
 const keys=jobs.map(j=>watermarkKey(j.binding,j.range));if(new Set(keys).size!==keys.length)throw new StoreError("invalid_payload","Duplicate extraction job");
 const store=await openStore(root,request.profile_id);
 try{
  const snap=await store.read();
  for(let i=0;i<jobs.length;i++){
   const j=jobs[i],wm=snap.extraction_watermarks[keys[i]];
   if(!isCurrentBinding(snap,j.binding)||!wm||wm.completed||wm.attempts>=MAX_AUTO_ATTEMPTS||wm.request.job_uid!==j.request?.job_uid||wm.request.binding_revision!==first.revision||wm.request.binding_uid!==first.binding_uid||wm.request.soul_uid!==first.soul_uid)return {claimed:false,reason:"unavailable"};
   if(wm.state==="running"&&wm.claimed_at&&Date.now()-Date.parse(wm.claimed_at)<10*60000)return {claimed:false,reason:"claimed"};
  }
  try{if(!canReserve(snap.extraction_usage,first,units))return {claimed:false,reason:"resource_budget"};}
  catch{return {claimed:false,reason:"resource_budget_corrupt"};}
  await store.transact(d=>{
   d.extraction_usage=reserve(d.extraction_usage,first,units);
   for(const key of keys){const wm=d.extraction_watermarks[key];wm.state="running";wm.attempts++;wm.last_error=null;wm.claimed_at=new Date().toISOString();}
  });return {claimed:true};
 }finally{await store.close();}
});

export async function drainPendingExtractions(
 root:string,adapters:Partial<Record<string,RuntimeAdapter>>,options:{fs?:Partial<StoreFs>;diagnostic?:(counts:ExtractionDiagnostic)=>void}={},
):Promise<{started:number;completed:number;failed:number}>{
 const rootDir=resolveRoot(root),fs=openFs(options),stats={started:0,completed:0,failed:0};
 const resource={stage:"resource" as const,pending:0,budget_deferred:0,stale_pending:0,source_deferred:0};
 for(const profileId of await listProfiles(rootDir)){
  await sendWriterCommand(rootDir,profileId,"observe_codex",{});
  for(const ref of await pendingSourceCaptures(rootDir,profileId))await sendWriterCommand(rootDir,profileId,"resolve_source_capture",{event_ref:ref});
  const store=await openStore(rootDir,profileId,{fs});const pending:PendingJob[]=[];
  try{const snap=await store.read();for(const [key,wm]of Object.entries(snap.extraction_watermarks)){
   if(wm.completed||wm.attempts>=MAX_AUTO_ATTEMPTS)continue;resource.pending++;
   const binding=findBindingByUid(snap,wm.request.binding_uid);
   if(!binding||binding.revision!==wm.request.binding_revision){resource.stale_pending++;continue;}
   pending.push({binding,range:rangeFromKeyAndRequest(key,wm.request),request:wm.request,queued_at:wm.queued_at,attempts:wm.attempts});
  }}finally{await store.close();}
  const groups=new Map<string,PendingJob[]>();
  for(const job of pending){const id=JSON.stringify([job.binding.binding_uid,job.binding.revision]);const group=groups.get(id)??[];group.push(job);groups.set(id,group);}
  const ordered=[...groups.values()];
  const ready=new Map<PendingJob[],Array<{job:PendingJob;meta:PreparedExtraction}>>();
  for(const group of ordered){
   const adapter=adapters[group[0].request.runtime_kind];if(!adapter?.prepare)continue;
   const budgetStore=await openStore(rootDir,profileId,{fs});let hasBudget=false;
   try{const current=await budgetStore.read();try{hasBudget=canReserve(current.extraction_usage,group[0].binding,1);}catch{hasBudget=false;}}
   finally{await budgetStore.close();}
   if(!hasBudget){resource.budget_deferred+=group.length;continue;}
   const prepared:Array<{job:PendingJob;meta:PreparedExtraction}>=[];
   for(const job of group){
    let meta:PreparedExtraction;try{meta=await adapter.prepare(job.request);}catch{meta={available:false,urgent:false,input_bytes:0,error_code:"source_preparation_failed"};}
    if(meta.available)prepared.push({job,meta});
    else{resource.source_deferred++;await sendWriterCommand(rootDir,profileId,"defer_extraction",{binding:job.binding,range:job.range,reason:meta.error_code??"source_preparation_failed"});}
   }ready.set(group,prepared);
  }
  // A different session's ordinary backlog must not consume the final shared allowance first.
  ordered.sort((a,b)=>Number(ready.get(b)?.some(r=>r.meta.urgent)??false)-Number(ready.get(a)?.some(r=>r.meta.urgent)??false));
  for(const group of ordered){
   const adapter=adapters[group[0].request.runtime_kind];if(!adapter)continue;
   if(!adapter.prepare){
    // Keep the direct/injected adapter API immediate; production adapters are wrapped.
    for(const job of group){const begin=await beginExtraction(rootDir,job.binding,job.range,job.request.job_uid);if(!begin.scheduled)continue;
     registerInternalJob({jobUid:job.request.job_uid,root:rootDir,profileId,binding:job.binding,range:job.range,request:job.request});
     try{const result=await runExtraction(job.request.job_uid,adapter,{root:rootDir,diagnostic:options.diagnostic});stats.started++;if("error"in result)stats.failed++;else stats.completed++;}
     finally{unregisterInternalJob(job.request.job_uid);}
    }continue;
   }
   const prepared=ready.get(group);if(!prepared)continue;
   while(prepared.length){
    const urgent=prepared.findIndex(row=>row.meta.urgent);if(urgent>0)prepared.unshift(...prepared.splice(urgent,1));
    const oldest=Math.min(...prepared.map(row=>row.job.queued_at?Date.parse(row.job.queued_at):0));
    if(prepared.length<3&&urgent<0&&Date.now()-oldest<90000)break;
    const batch=[];let inputBytes=0;const max=prepared.slice(0,3).some(row=>(row.job.attempts??0)>0)?1:adapter.batchSupported&&adapter.extractBatch?3:1;
    while(prepared.length&&batch.length<max){const row=prepared[0];if(inputBytes+row.meta.input_bytes+512>24576)break;batch.push(prepared.shift()!);inputBytes+=row.meta.input_bytes;}
    if(!batch.length){resource.source_deferred++;prepared.shift();continue;}
    const jobs=batch.map(r=>r.job);const claimed=await sendWriterCommand(rootDir,profileId,"reserve_extraction_batch",{jobs,reserved_units:inputBytes+1024});
    if(!claimed.ok||!(claimed.result as {claimed?:boolean})?.claimed){if(claimed.ok&&String((claimed.result as {reason?:string}).reason).startsWith("resource_budget"))resource.budget_deferred+=jobs.length;continue;}
    for(const job of jobs)registerInternalJob({jobUid:job.request.job_uid,root:rootDir,profileId,binding:job.binding,range:job.range,request:job.request});
    try{
     let results:ExtractionResult[];try{results=adapter.extractBatch?await adapter.extractBatch(jobs.map(j=>j.request)):await Promise.all(jobs.map(j=>adapter.extract(j.request)));}catch{results=jobs.map(()=>({error:{code:"adapter_failed",retryable:true}}));}
     for(let i=0;i<jobs.length;i++){
      const job=jobs[i],result=results[i]??{error:{code:"batch_result_missing",retryable:true}};stats.started++;
      if("error"in result){await failExtraction(rootDir,profileId,watermarkKey(job.binding,job.range),result.error.code);stats.failed++;}
      else{try{for(const d of await commitResult(rootDir,job.binding,job.range,result.proposals))options.diagnostic?.(d);stats.completed++;}catch{await failExtraction(rootDir,profileId,watermarkKey(job.binding,job.range),"stale_binding");stats.failed++;}}
     }
    }finally{for(const job of jobs)unregisterInternalJob(job.request.job_uid);}
   }
  }
 }
 options.diagnostic?.(resource);return stats;
}

/** Sync may enumerate retired records; extraction must use only the canonical key. */
function isCurrentBinding(snap: StoreSnapshot, binding: BindingSnapshot): boolean {
  const current = snap.bindings[bindingKey(binding)];
  return binding.retired !== true && current !== undefined && current.retired !== true &&
    bindingKey(current) === bindingKey(binding) && current.state === "bound" &&
    current.binding_uid === binding.binding_uid && current.revision === binding.revision &&
    current.soul_uid === binding.soul_uid && current.session_ref === binding.session_ref;
}

function findBindingByUid(snap: StoreSnapshot, bindingUid: string): BindingSnapshot | undefined {
  return Object.values(snap.bindings).find((binding) => binding.binding_uid === bindingUid && isCurrentBinding(snap, binding));
}

function rangeFromKeyAndRequest(key: string, request: ExtractionRequest): SourceRange {
  // key = <session>#<start>-<end>#rev<N>
  const match = /#(-?\d+)-(-?\d+)#rev\d+$/.exec(key);
  const start = match ? Number(match[1]) : 0;
  const end = match ? Number(match[2]) : 0;
  return {
    event_refs: request.source_event_refs.slice(),
    start,
    end,
    ...(request.source_turn_refs !== undefined ? { turn_refs: request.source_turn_refs.slice() } : {}),
  };
}

async function listProfiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(profilesDir(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
