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
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import type {
  BindingSnapshot,
  ExtractionRequest,
  ExtractionResult,
  RuntimeAdapter,
  RuntimeEvent,
  SourceRange,
} from "../adapters/types.js";
import { contentDigest, type AssetSource, type ProposedAsset } from "../assets/protocol.js";
import { classifyProposalState, validateProposedAsset } from "../assets/validation.js";
import { captureSourcePointer, extractTranscriptPath, validateTranscriptPath } from "../agentd/source-index.js";
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
import { assertBindingCurrent, resolveBinding } from "../local/bindings.js";
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
  const interval = refsDigest([event.event_ref]);
  return { event_refs: [event.event_ref], start: interval, end: interval };
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

  await commitResult(root, job.binding, job.range, result.proposals);
  return result;
}

// --- write paths: every snapshot write goes through the single writer --------------

type ExtractionCommand = "begin_extraction" | "commit_extraction" | "fail_extraction";

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
): Promise<void> {
  const result = await sendWriterCommand(root, binding.profile_id, "commit_extraction", {
    binding,
    range,
    proposals,
  });
  if (!result.ok) throw new StoreError(result.error.code, result.error.message);
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

/** Reserve one attempt (writer-serialized): write `pending` and bump the counter. */
async function beginExtractionDirect(
  root: string,
  binding: BindingSnapshot,
  range: SourceRange,
  jobUid: string,
  fs: StoreFs,
): Promise<{ scheduled: boolean; reason?: string }> {
  const profileId = binding.profile_id;
  const key = watermarkKey(binding, range);
  const store = await openStore(root, profileId, { fs });
  try {
    const snap = await store.read();
    const existing = snap.extraction_watermarks[key];
    if (existing?.completed) return { scheduled: false, reason: "completed" };
    if (existing && existing.attempts >= MAX_AUTO_ATTEMPTS) {
      return { scheduled: false, reason: "budget_exhausted" };
    }
    await store.transact((draft) => {
      const prior = draft.extraction_watermarks[key];
      draft.extraction_watermarks[key] = {
        completed: false,
        attempts: (prior?.attempts ?? 0) + 1,
        state: "pending",
        last_error: prior?.last_error ?? null,
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
): Promise<{ committed: boolean; reason?: string }> {
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

    for (const raw of proposals) {
      let proposal: ProposedAsset;
      try {
        proposal = validateProposedAsset(raw);
      } catch {
        continue; // a malformed proposal is dropped locally, never uploaded
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
    return { committed: true };
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
  if (!(APPLICABLE_EVENT_KINDS as readonly string[]).includes(event.kind)) {
    return { scheduled: false, reason: "not_applicable" };
  }
  const binding = await resolveBinding(event.key, undefined, { root: options.root, fs: options.fs });
  if (!binding) return { scheduled: false, reason: "no_binding" };
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
registerWriterCommand("runtime_event", async ({ root, request }) => {
  const event = request.payload.event;
  if (!isRuntimeEvent(event)) {
    throw new StoreError("invalid_event", "runtime_event payload.event must be a valid RuntimeEvent");
  }
  if (isInternalEvent(event)) return { scheduled: false, reason: "internal" };

  // Task 10c: record the host's own transcript location as a path pointer for this
  // event ref — path only, never text. Validated here (absolute, existing regular
  // file); runtimes that omit a transcript location are never indexed.
  const candidate = extractTranscriptPath(request.payload);
  if (candidate !== null) {
    const valid = await validateTranscriptPath(candidate);
    if (valid !== null) {
      await captureSourcePointer(root, event.key.profile_id, event.event_ref, {
        runtime_kind: event.key.runtime_kind,
        native_session_id: event.key.native_session_id,
        path: valid,
        captured_at: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  if (!(APPLICABLE_EVENT_KINDS as readonly string[]).includes(event.kind)) {
    return { scheduled: false, reason: "not_applicable" };
  }
  const binding = await resolveBinding(event.key, undefined, { root });
  if (!binding) return { scheduled: false, reason: "no_binding" };

  const jobUid = randomUUID();
  const result = await beginExtractionDirect(root, binding, rangeForEvent(event), jobUid, defaultStoreFs);
  return { ...result, job_uid: jobUid };
});

registerWriterCommand("begin_extraction", async ({ root, request }) => {
  const p = request.payload;
  if (!isBindingSnapshot(p.binding) || !isSourceRange(p.range)) {
    throw new StoreError("invalid_payload", "begin_extraction requires a binding and a range");
  }
  const jobUid = typeof p.job_uid === "string" && p.job_uid ? p.job_uid : randomUUID();
  return beginExtractionDirect(root, p.binding, p.range, jobUid, defaultStoreFs);
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
export async function drainPendingExtractions(
  root: string,
  adapters: Partial<Record<string, RuntimeAdapter>>,
  options: { fs?: Partial<StoreFs> } = {},
): Promise<{ started: number; completed: number; failed: number }> {
  const rootDir = resolveRoot(root);
  const fs = openFs(options);
  const stats = { started: 0, completed: 0, failed: 0 };

  const profileIds = await listProfiles(rootDir);
  for (const profileId of profileIds) {
    const store = await openStore(rootDir, profileId, { fs });
    let pending: Array<{ binding: BindingSnapshot; range: SourceRange; request: ExtractionRequest }> = [];
    try {
      const snap = await store.read();
      for (const [key, wm] of Object.entries(snap.extraction_watermarks)) {
        if (wm.completed || wm.attempts >= MAX_AUTO_ATTEMPTS) continue;
        const binding = findBindingByUid(snap, wm.request.binding_uid);
        if (!binding || binding.revision !== wm.request.binding_revision) continue; // stale: explicit handling only
        pending.push({ binding, range: rangeFromKeyAndRequest(key, wm.request), request: wm.request });
      }
    } finally {
      await store.close();
    }

    for (const job of pending) {
      const adapter = adapters[job.request.runtime_kind];
      if (!adapter) continue;
      // Reserve the attempt through the same writer command the schedule path uses,
      // so a range drained concurrently with a checkpoint cannot exceed its budget.
      const begin = await beginExtraction(rootDir, job.binding, job.range, job.request.job_uid);
      if (!begin.scheduled) continue; // completed or budget exhausted since the read
      const jobUid = job.request.job_uid;
      registerInternalJob({ jobUid, root: rootDir, profileId, binding: job.binding, range: job.range, request: job.request });
      try {
        const result = await runExtraction(jobUid, adapter, { root: rootDir });
        stats.started += 1;
        if ("error" in result) stats.failed += 1;
        else stats.completed += 1;
      } finally {
        unregisterInternalJob(jobUid);
      }
    }
  }
  return stats;
}

function findBindingByUid(snap: StoreSnapshot, bindingUid: string): BindingSnapshot | undefined {
  return Object.values(snap.bindings).find((binding) => binding.binding_uid === bindingUid);
}

function rangeFromKeyAndRequest(key: string, request: ExtractionRequest): SourceRange {
  // key = <session>#<start>-<end>#rev<N>
  const match = /#(-?\d+)-(-?\d+)#rev\d+$/.exec(key);
  const start = match ? Number(match[1]) : 0;
  const end = match ? Number(match[2]) : 0;
  return { event_refs: request.source_event_refs.slice(), start, end };
}

async function listProfiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(profilesDir(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
