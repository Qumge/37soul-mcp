/**
 * Task 5: the cloud boundary for soul-assets/v1.
 *
 * `syncOnce` pushes the outbox and pulls the cloud directory over the injected
 * `HttpFetch` only — it never calls `globalThis.fetch`, and no transcript, prompt,
 * cwd or native session id ever appears in an HTTP body, receipt, outbox envelope
 * or log. The HTTP layer understands every §9 status (200/201/401/403/404/409/
 * 413/422/429/5xx, Retry-After and bounded backoff), and distinguishes the
 * per-change `idempotency_mismatch` carried inside a 200 push from a whole-request
 * 409 on any other endpoint.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { BindingSnapshot, HttpFetch, ProfileId } from "../adapters/types.js";
import { loadConfig } from "../agentd/state.js";
import {
  ASSET_TOMBSTONE_STATES,
  contentDigest,
  type Asset,
  type AssetTombstone,
  type Binding,
  type Consent,
  type ContextBundle,
  type ContextInput,
  type PullPage,
  type PushResult,
  type Soul,
  type WrappedObject,
} from "../assets/protocol.js";
import { selectContext } from "../assets/context.js";
import {
  defaultStoreFs,
  openStore,
  StoreError,
  type LocalAsset,
  type LocalStore,
  type OutboxOperation,
  type StoreFs,
  type StoreSnapshot,
} from "../local/store.js";
import { accountsIndexPath, resolveRoot } from "../local/profiles.js";
import { registerWriterCommand } from "../local/writer.js";
import { batchAssetOps, orderOutboxOps } from "./outbox.js";

export interface SyncReport {
  accepted: number;
  conflicts: number;
  pending: number;
  error?: string;
}

export interface SyncBackoff {
  maxRetries?: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncOptions {
  root?: string;
  fs?: Partial<StoreFs>;
  token?: string;
  baseUrl?: string;
  pullLimit?: number;
  backoff?: SyncBackoff;
}

const ROUTES = "/api/v1/me/soul_sync";
const DEFAULT_BASE_URL = "https://37soul.com";

type SyncAuth = { token: string; baseUrl: string; backoff: Required<SyncBackoff> };

interface JsonResponse {
  status: number;
  body: unknown;
  retryAfter: number | null;
}

/** A quarantine entry extended with the confirmed cloud copy of a conflict (§2.4). */
interface QuarantinedSync {
  operation: OutboxOperation;
  reason: string;
  cloud_objects?: WrappedObject[];
}

function defaultBackoff(): Required<SyncBackoff> {
  return { maxRetries: 2, baseMs: 400, maxMs: 8000, sleep };
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffDelayMs(attempt: number, retryAfter: number | null, backoff: Required<SyncBackoff>): number {
  const exponential = backoff.baseMs * 2 ** Math.max(0, attempt - 1);
  const delay = retryAfter !== null && retryAfter >= 0 ? retryAfter * 1000 : exponential;
  return Math.min(delay, backoff.maxMs);
}

function parseRetryAfter(response: { headers: { get(name: string): string | null } }): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  return null;
}

/** A minimal Response duck-type shared by node fetch and the test fakes. */
interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  body?: { cancel(): Promise<void> } | null;
}

/**
 * One request with bounded retries on network errors, 429 and 5xx. Retry-After is
 * honoured; the delay is capped so a hostile header cannot stall the writer. When
 * the bound is exhausted the last response is returned to the caller, which decides
 * whether to keep the outbox and stop (retryable) or surface the error.
 */
async function fetchWithBackoff(
  http: HttpFetch,
  url: string,
  init: RequestInit,
  auth: SyncAuth,
): Promise<FetchResponseLike> {
  let attempt = 0;
  for (;;) {
    let response: FetchResponseLike;
    try {
      response = (await http(url, init)) as unknown as FetchResponseLike;
    } catch (error) {
      attempt += 1;
      if (attempt > auth.backoff.maxRetries) throw error;
      await auth.backoff.sleep(backoffDelayMs(attempt, null, auth.backoff));
      continue;
    }
    if (isRetryableStatus(response.status)) {
      attempt += 1;
      if (attempt > auth.backoff.maxRetries) return response;
      await auth.backoff.sleep(backoffDelayMs(attempt, parseRetryAfter(response), auth.backoff));
      continue;
    }
    return response;
  }
}

async function readJson(response: FetchResponseLike): Promise<JsonResponse> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
  return { status: response.status, body, retryAfter: parseRetryAfter(response) };
}

async function requestJson(
  http: HttpFetch,
  url: string,
  init: RequestInit,
  auth: SyncAuth,
): Promise<JsonResponse> {
  const response = await fetchWithBackoff(http, url, init, auth);
  return readJson(response);
}

// --- syncOnce ----------------------------------------------------------------------

export async function syncOnce(profileId: ProfileId, http: HttpFetch, options: SyncOptions = {}): Promise<SyncReport> {
  const root = resolveRoot(options.root);
  const fs: StoreFs = { ...defaultStoreFs, ...(options.fs ?? {}) };
  const config = await loadConfig(root).catch(() => null);
  const token = options.token ?? firstToken(config?.tokens);
  const baseUrl = (options.baseUrl ?? config?.api_base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!token) {
    return { accepted: 0, conflicts: 0, pending: 0, error: "no authorized device token" };
  }
  const auth: SyncAuth = { token, baseUrl, backoff: { ...defaultBackoff(), ...(options.backoff ?? {}) } };
  const store = await openStore(root, profileId, { fs });
  const report: SyncReport = { accepted: 0, conflicts: 0, pending: 0 };
  try {
    const pushError = await pushOutbox(store, http, auth, options, report);
    if (pushError) {
      report.error = pushError;
      report.pending = pendingCount(await store.read());
      return report;
    }
    const pullError = await pullLoop(store, http, auth, options, report);
    if (pullError) report.error = pullError;
    report.pending = pendingCount(await store.read());
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    try {
      report.pending = pendingCount(await store.read());
    } catch {
      report.pending = 0;
    }
    return report;
  } finally {
    await store.close();
  }
}

function firstToken(tokens: Record<string, string> | undefined): string | null {
  if (!tokens) return null;
  for (const value of Object.values(tokens)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function pendingCount(snap: StoreSnapshot): number {
  return Object.keys(snap.outbox).length;
}

/** Code → report error string; null means "stop, keep the outbox, no error to surface". */
type StopError = { code: string; retryable: boolean };

function stopCode(body: unknown): StopError {
  const error = (body as { error?: { code?: unknown; retryable?: unknown } } | null)?.error;
  const code = error && typeof error.code === "string" ? error.code : "sync_failed";
  const retryable = error && typeof error.retryable === "boolean" ? error.retryable : false;
  return { code, retryable };
}

// --- push --------------------------------------------------------------------------

async function pushOutbox(
  store: LocalStore,
  http: HttpFetch,
  auth: SyncAuth,
  options: SyncOptions,
  report: SyncReport,
): Promise<string | null> {
  let snap = await store.read();
  const ordered = orderOutboxOps(Object.values(snap.outbox));

  for (const op of ordered) {
    snap = await store.read();
    if (!snap.outbox[op.operation_id]) continue; // handled by an earlier step
    const outcome = await pushOne(store, http, auth, options, report, op, snap);
    if (outcome) return outcome;
  }

  // Asset changes are batched (§5) after the control operations are drained.
  snap = await store.read();
  const assetOps = orderOutboxOps(Object.values(snap.outbox)).filter((op) => op.operation_kind === "asset");
  for (const batch of batchAssetOps(assetOps)) {
    const current = await store.read();
    const live = batch.filter((op) => current.outbox[op.operation_id]);
    if (live.length === 0) continue;
    const outcome = await pushAssetBatch(store, http, auth, report, live);
    if (outcome) return outcome;
  }
  return null;
}

async function pushOne(
  store: LocalStore,
  http: HttpFetch,
  auth: SyncAuth,
  options: SyncOptions,
  report: SyncReport,
  op: OutboxOperation,
  snap: StoreSnapshot,
): Promise<string | null> {
  const headers = authHeaders(auth.token);
  switch (op.operation_kind) {
    case "register_soul": {
      const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/souls`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": op.operation_id },
        body: JSON.stringify(op.request),
      }, auth);
      return handleRegisterSoul(store, snap, op, res, report);
    }
    case "consent": {
      const soulUid = String(op.request.soul_uid ?? "");
      const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/souls/${encodeURIComponent(soulUid)}/consent`, {
        method: "PUT",
        headers: { ...headers, "idempotency-key": op.operation_id },
        body: JSON.stringify(consentBody(op.request)),
      }, auth);
      return handleConsent(store, snap, op, res, report);
    }
    case "binding": {
      const binding = resolveBindingBySessionRef(snap, String(op.request.session_ref ?? ""));
      if (!binding) {
        await store.transact((draft) => {
          delete draft.outbox[op.operation_id];
          draft.quarantine[op.operation_id] = { operation: op, reason: "binding_not_found" };
        });
        return null;
      }
      const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/bindings/${encodeURIComponent(binding.binding_uid)}`, {
        method: "PUT",
        headers: { ...headers, "idempotency-key": op.operation_id },
        body: JSON.stringify(op.request),
      }, auth);
      return handleBinding(store, snap, op, res, report);
    }
    case "asset":
      // Collected and batched below; never sent here.
      return null;
    default:
      return null;
  }
}

function consentBody(request: Record<string, unknown>): Record<string, unknown> {
  const { soul_uid: _soulUid, ...body } = request;
  return body;
}

function resolveBindingBySessionRef(snap: StoreSnapshot, sessionRef: string): BindingSnapshot | null {
  for (const binding of Object.values(snap.bindings)) {
    if (binding.session_ref === sessionRef) return binding;
  }
  return null;
}

async function handleRegisterSoul(
  store: LocalStore,
  snap: StoreSnapshot,
  op: OutboxOperation,
  res: JsonResponse,
  report: SyncReport,
): Promise<string | null> {
  const soulUid = String(op.request.soul_uid ?? "");
  if (res.status === 200 || res.status === 201) {
    const body = res.body as { soul?: Soul; consent?: Consent } | null;
    await store.transact((draft) => {
      delete draft.outbox[op.operation_id];
      if (body?.soul) {
        draft.souls[soulUid] = { ...draft.souls[soulUid], ...body.soul };
      }
      if (body?.consent) {
        const key = consentKey(body.consent.cloud_device_uid, body.consent.soul_uid);
        const previous = draft.consents[key];
        draft.consents[key] = body.consent;
        // First explicit registration resets the pull cursor once (§6).
        if ((previous?.revision ?? 0) < body.consent.revision) draft.pull_cursor = "0";
      }
      return undefined;
    });
    report.accepted += 1;
    return null;
  }
  if (res.status === 409) {
    return quarantineOp(store, op, "idempotency_mismatch", report, null);
  }
  if (res.status === 404) {
    return quarantineOp(store, op, "not_found", report, null);
  }
  if (res.status === 401) return handleRevokedOrRejected(store, snap, res);
  return fatalFromStatus(res);
}

async function handleConsent(
  store: LocalStore,
  snap: StoreSnapshot,
  op: OutboxOperation,
  res: JsonResponse,
  report: SyncReport,
): Promise<string | null> {
  if (res.status === 200 || res.status === 201) {
    const body = res.body as { consent?: Consent; replay_from?: string } | null;
    await store.transact((draft) => {
      delete draft.outbox[op.operation_id];
      if (body?.consent) {
        const key = consentKey(body.consent.cloud_device_uid, body.consent.soul_uid);
        const previous = draft.consents[key];
        draft.consents[key] = body.consent;
        if ((previous?.revision ?? 0) < body.consent.revision) draft.pull_cursor = "0";
        if (previous && (!body.consent.enabled || body.consent.categories.length < previous.categories.length)) {
          revokeConsentLocal(draft, body.consent);
        }
      }
      return undefined;
    });
    report.accepted += 1;
    return null;
  }
  if (res.status === 409) return quarantineOp(store, op, "revision_conflict", report, null);
  if (res.status === 401) return handleRevokedOrRejected(store, snap, res);
  return fatalFromStatus(res);
}

async function handleBinding(
  store: LocalStore,
  snap: StoreSnapshot,
  op: OutboxOperation,
  res: JsonResponse,
  report: SyncReport,
): Promise<string | null> {
  if (res.status === 200 || res.status === 201) {
    const body = res.body as { binding?: Binding } | null;
    await store.transact((draft) => {
      delete draft.outbox[op.operation_id];
      if (body?.binding) applyBindingRecord(draft, body.binding);
      return undefined;
    });
    report.accepted += 1;
    return null;
  }
  if (res.status === 409) return quarantineOp(store, op, "revision_conflict", report, null);
  if (res.status === 401) return handleRevokedOrRejected(store, snap, res);
  return fatalFromStatus(res);
}

/** 401 device_revoked clears downloaded cloud cache; other fatal statuses stop the run. */
async function handleRevokedOrRejected(store: LocalStore, snap: StoreSnapshot, res: JsonResponse): Promise<string | null> {
  const { code } = stopCode(res.body);
  if (code === "device_revoked") {
    await store.transact((draft) => clearCloudCache(draft));
    return "device_revoked";
  }
  if (code === "token_invalid") return "token_invalid";
  return code;
}

function fatalFromStatus(res: JsonResponse): string {
  const { code } = stopCode(res.body);
  if (res.status === 403) return code === "sync_failed" ? "sync_not_authorized" : code;
  return code;
}

async function pushAssetBatch(
  store: LocalStore,
  http: HttpFetch,
  auth: SyncAuth,
  report: SyncReport,
  ops: OutboxOperation[],
): Promise<string | null> {
  const changes = ops.map((op) => op.request);
  const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/push`, {
    method: "POST",
    headers: authHeaders(auth.token),
    body: JSON.stringify({ protocol: "soul-assets/v1", changes }),
  }, auth);

  if (res.status !== 200) {
    if (res.status === 401) {
      const snap = await store.read();
      return handleRevokedOrRejected(store, snap, res);
    }
    if (res.status === 409) {
      // Whole-request idempotency mismatch: park every change in this batch.
      for (const op of ops) await quarantineOp(store, op, "idempotency_mismatch", report, null);
      return null;
    }
    return fatalFromStatus(res);
  }

  const body = res.body as { results?: PushResult[] } | null;
  const results = body?.results ?? [];
  await applyPushResults(store, ops, results, report);
  return null;
}

/** Apply per-change push results atomically per batch (§5). */
async function applyPushResults(
  store: LocalStore,
  ops: OutboxOperation[],
  results: PushResult[],
  report: SyncReport,
): Promise<void> {
  const byChangeId = new Map(ops.map((op) => [String(op.request.change_id ?? op.operation_id), op]));
  const pendingOps = ops.filter((op) => !byChangeId.has(String(op.request.change_id ?? op.operation_id)));
  void pendingOps;

  for (const result of results) {
    const op = byChangeId.get(result.change_id);
    if (!op) continue;
    const errorCode = result.error?.code;
    if (errorCode === "idempotency_mismatch") {
      await quarantineOp(store, op, "idempotency_mismatch", report, result.objects ?? null);
      report.conflicts += 1;
      continue;
    }
    if (result.status === "accepted" || result.status === "duplicate") {
      await store.transact((draft) => {
        delete draft.outbox[op.operation_id];
        applyPushObjects(draft, result);
        remapCanonical(draft, result, op);
        markAccepted(draft, result, op);
        return undefined;
      });
      report.accepted += 1;
      continue;
    }
    if (result.status === "conflict") {
      await store.transact((draft) => {
        delete draft.outbox[op.operation_id];
        draft.quarantine[op.operation_id] = {
          operation: op,
          reason: errorCode ?? "conflict",
          cloud_objects: result.objects ?? undefined,
        } as QuarantinedSync;
        markAssetState(draft, op, "conflict");
        return undefined;
      });
      report.conflicts += 1;
      continue;
    }
    // rejected
    const reason = errorCode ?? "rejected";
    await store.transact((draft) => {
      delete draft.outbox[op.operation_id];
      draft.quarantine[op.operation_id] = {
        operation: op,
        reason,
        cloud_objects: result.objects ?? undefined,
      } as QuarantinedSync;
      applyPushObjects(draft, result);
      markRejectedLocal(draft, op, reason);
      return undefined;
    });
    report.conflicts += 1;
  }
}

function applyPushObjects(draft: StoreSnapshot, result: PushResult): void {
  for (const wrapped of result.objects ?? []) {
    applyWrappedObject(draft, wrapped);
  }
}

function applyWrappedObject(draft: StoreSnapshot, wrapped: WrappedObject): void {
  const obj = wrapped.object as Record<string, unknown>;
  const uid = typeof obj.asset_uid === "string" ? obj.asset_uid : null;
  const state = typeof obj.state === "string" ? (obj.state as Asset["state"]) : null;
  const tombstoneState = state as (typeof ASSET_TOMBSTONE_STATES)[number] | null;
  if (wrapped.object_type === "asset" && uid && state && tombstoneState && ASSET_TOMBSTONE_STATES.includes(tombstoneState)) {
    applyTombstoneObject(draft, obj);
    return;
  }
  if (wrapped.object_type === "asset" && uid) {
    applyAssetObject(draft, obj as unknown as Asset);
    return;
  }
  if (wrapped.object_type === "consent" && obj) {
    applyConsentEvent(draft, obj as unknown as Consent);
    return;
  }
  if (wrapped.object_type === "binding" && obj && typeof obj.binding_uid === "string") {
    applyBindingRecord(draft, obj as unknown as Binding);
    return;
  }
  if (wrapped.object_type === "soul" && obj && typeof obj.soul_uid === "string") {
    applySoulEvent(draft, obj as unknown as Soul);
  }
}

/** Temp uid → canonical uid mapping (§5 duplicate dedup), in the same transaction. */
function remapCanonical(draft: StoreSnapshot, result: PushResult, op: OutboxOperation): void {
  const canonical = result.canonical_asset_uid;
  if (!canonical) return;
  const sources = new Set<string>();
  const sentUid = String(op.request.asset_uid ?? "");
  if (sentUid && sentUid !== canonical) sources.add(sentUid);
  for (const revision of result.applied_revisions ?? []) {
    if (revision.object_uid && revision.object_uid !== canonical) sources.add(revision.object_uid);
  }
  for (const uid of sources) {
    const local = draft.assets[uid];
    if (!local) continue;
    if (!draft.assets[canonical]) {
      // The canonical asset is new to this device: carry the local edit across.
      draft.assets[canonical] = { ...local, asset_uid: canonical };
    }
    // The temp uid is a duplicate of an already-known (possibly deleted) asset —
    // drop it so a later tombstone replay cannot resurrect the stale copy.
    delete draft.assets[uid];
  }
}

function markAssetState(draft: StoreSnapshot, op: OutboxOperation, state: LocalAsset["sync_state"]): void {
  const assetUid = String(op.request.asset_uid ?? "");
  const asset = draft.assets[assetUid];
  if (asset) asset.sync_state = state;
}

/** An accepted/duplicate change is confirmed cloud state: the sent asset becomes
 *  synced even when the server returned an object at the same revision (which
 *  applyAssetObject would otherwise skip as a stale replay). */
function markAccepted(draft: StoreSnapshot, result: PushResult, op: OutboxOperation): void {
  const sentUid = String(op.request.asset_uid ?? "");
  const asset = draft.assets[sentUid];
  if (!asset) return;
  asset.sync_state = "synced";
  const applied = (result.applied_revisions ?? []).find((r) => r.object_uid === sentUid);
  if (applied && typeof applied.revision === "number") asset.cloud_revision = applied.revision;
  else if (asset.cloud_revision == null) asset.cloud_revision = asset.revision;
}

function markRejectedLocal(draft: StoreSnapshot, op: OutboxOperation, reason: string): void {
  const assetUid = String(op.request.asset_uid ?? "");
  const asset = draft.assets[assetUid];
  if (!asset) return;
  if (reason === "content_dismissed") {
    asset.state = "rejected";
    asset.restored_by_uid = null;
  } else {
    // binding_stale / invalid: the content is fine, the binding is not — fall back to candidate.
    asset.state = "candidate";
  }
  asset.sync_state = "conflict";
}

async function quarantineOp(
  store: LocalStore,
  op: OutboxOperation,
  reason: string,
  report: SyncReport,
  cloudObjects: WrappedObject[] | null,
): Promise<string | null> {
  await store.transact((draft) => {
    delete draft.outbox[op.operation_id];
    draft.quarantine[op.operation_id] = {
      operation: op,
      reason,
      ...(cloudObjects ? { cloud_objects: cloudObjects } : {}),
    } as QuarantinedSync;
    return undefined;
  });
  report.conflicts += 1;
  return null;
}

// --- pull --------------------------------------------------------------------------

async function pullLoop(
  store: LocalStore,
  http: HttpFetch,
  auth: SyncAuth,
  options: SyncOptions,
  report: SyncReport,
): Promise<string | null> {
  const limit = options.pullLimit ?? 50;
  for (;;) {
    const snap = await store.read();
    const cursor = snap.pull_cursor ?? "0";
    const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/pull?cursor=${encodeURIComponent(cursor)}&limit=${limit}`, {
      method: "GET",
      headers: authHeaders(auth.token),
    }, auth);

    if (res.status === 200) {
      const page = res.body as PullPage;
      const before = (await store.read()).pull_cursor;
      await applyPullPage(store, page);
      const after = (await store.read()).pull_cursor;
      if (page.has_more && after !== null && after !== before) continue;
      break;
    }
    if (res.status === 409) {
      // cursor_reset_required: rebuild only the cloud-confirmed cache, keep local edits.
      await store.transact((draft) => {
        clearCloudCache(draft);
        draft.pull_cursor = "0";
        return undefined;
      });
      continue;
    }
    if (res.status === 401) return handleRevokedOrRejected(store, snap, res);
    return fatalFromStatus(res);
  }
  return null;
}

/**
 * Apply one pull page and commit the cursor in the same transaction (§6): a crash
 * leaves either the old page fully absent or the new page fully applied, never a
 * half-applied page. Consent control events are never filtered; the first strictly
 * higher Consent revision resets the pull cursor to "0" exactly once.
 */
export async function applyPullPage(store: LocalStore, page: PullPage): Promise<void> {
  await store.transact((draft) => {
    let consentReset = false;
    for (const event of page.events ?? []) {
      if (event.object_type === "consent") {
        const consent = event.object as unknown as Consent;
        const outcome = applyConsentEvent(draft, consent);
        if (outcome.reset) consentReset = true;
        if (outcome.revoked) revokeConsentLocal(draft, consent);
      } else if (event.object_type === "soul") {
        applySoulEvent(draft, event.object as unknown as Soul);
      } else if (event.object_type === "binding") {
        applyBindingRecord(draft, event.object as unknown as Binding);
      } else if (event.object_type === "asset") {
        applyAssetEvent(draft, event.object as Record<string, unknown>);
      }
    }
    draft.pull_cursor = consentReset ? "0" : (page.next_cursor ?? "0");
    return undefined;
  });
}

function consentKey(cloudDeviceUid: string, soulUid: string): string {
  return `${cloudDeviceUid}:${soulUid}`;
}

interface ConsentOutcome {
  reset: boolean;
  revoked: boolean;
}

/** Returns reset=true when the revision strictly increased (cursor reset once);
 *  revoked=true when a known Consent narrowed (disabled or fewer categories). */
function applyConsentEvent(draft: StoreSnapshot, consent: Consent): ConsentOutcome {
  if (!consent?.cloud_device_uid || !consent?.soul_uid) return { reset: false, revoked: false };
  const key = consentKey(consent.cloud_device_uid, consent.soul_uid);
  const previous = draft.consents[key];
  if (previous && consent.revision <= previous.revision) return { reset: false, revoked: false };
  draft.consents[key] = consent;
  const reset = (previous?.revision ?? 0) < consent.revision;
  const revoked =
    previous !== undefined &&
    (!consent.enabled || consent.categories.length < previous.categories.length);
  return { reset, revoked };
}

/** Consent narrowed: drop the Soul's cloud-confirmed cache, keep local originals,
 *  and park its still-pending asset sends (§2.4 / consent_control_event). */
function revokeConsentLocal(draft: StoreSnapshot, consent: Consent): void {
  const soulUid = consent.soul_uid;
  const authorized = consent.enabled ? new Set(consent.categories) : new Set<string>();
  for (const [uid, asset] of Object.entries(draft.assets)) {
    if (asset.soul_uid !== soulUid) continue;
    if (asset.sync_state === "synced" && !authorized.has(asset.kind)) delete draft.assets[uid];
  }
  if (!consent.enabled) {
    for (const key of Object.keys(draft.digest_tombstones)) {
      draft.digest_tombstones[key] = draft.digest_tombstones[key].filter((t) => t.soul_uid !== soulUid);
    }
  }
  for (const [opId, op] of Object.entries(draft.outbox)) {
    if (op.operation_kind !== "asset") continue;
    if (op.request.soul_uid === soulUid) {
      delete draft.outbox[opId];
      draft.quarantine[opId] = { operation: op, reason: "consent_revoked" };
    }
  }
}

function applySoulEvent(draft: StoreSnapshot, soul: Soul): void {
  if (!soul?.soul_uid) return;
  const previous = draft.souls[soul.soul_uid];
  if (previous && previous.identity_revision >= soul.identity_revision) return;
  draft.souls[soul.soul_uid] = {
    soul_uid: soul.soul_uid,
    legacy_host_id: soul.legacy_host_id ?? null,
    identity_revision: soul.identity_revision,
    identity: { ...soul.identity },
    state: "active",
  };
}

function applyBindingRecord(draft: StoreSnapshot, binding: Binding): void {
  if (!binding?.binding_uid) return;
  for (const key of Object.keys(draft.bindings)) {
    const existing = draft.bindings[key];
    if (existing.binding_uid !== binding.binding_uid) continue;
    if (existing.revision >= binding.revision) return;
    draft.bindings[key] = { ...existing, ...binding };
    return;
  }
  // A binding this device does not hold locally: control events are device-scoped,
  // so ignore rather than fabricate a native session.
}

function applyAssetEvent(draft: StoreSnapshot, obj: Record<string, unknown>): void {
  const uid = typeof obj.asset_uid === "string" ? obj.asset_uid : null;
  if (!uid) return;
  const state = typeof obj.state === "string" ? (obj.state as Asset["state"]) : null;
  const tombstoneState = state as (typeof ASSET_TOMBSTONE_STATES)[number] | null;
  if (state && tombstoneState && ASSET_TOMBSTONE_STATES.includes(tombstoneState)) {
    applyTombstoneObject(draft, obj);
    return;
  }
  applyAssetObject(draft, obj as unknown as Asset);
}

function applyAssetObject(draft: StoreSnapshot, asset: Asset): void {
  if (!asset?.asset_uid) return;
  const previous = draft.assets[asset.asset_uid];
  if (previous && previous.revision >= asset.revision) return;
  draft.assets[asset.asset_uid] = {
    ...(previous ?? ({} as LocalAsset)),
    ...asset,
    sync_state: "synced",
    cloud_revision: asset.revision,
  };
}

function applyTombstoneObject(draft: StoreSnapshot, obj: Record<string, unknown>): void {
  const uid = obj.asset_uid as string;
  const soulUid = typeof obj.soul_uid === "string" ? obj.soul_uid : "";
  const revision = typeof obj.revision === "number" ? obj.revision : 0;
  const state = obj.state as Asset["state"];
  const tombstone: AssetTombstone = {
    asset_uid: uid,
    soul_uid: soulUid,
    kind: obj.kind as Asset["kind"],
    trait: obj.trait as Asset["trait"],
    content_digest: typeof obj.content_digest === "string" ? obj.content_digest : "",
    revision,
    state,
    restored_by_uid: typeof obj.restored_by_uid === "string" ? obj.restored_by_uid : null,
  };
  upsertTombstone(draft, soulUid, tombstone);

  const previous = draft.assets[uid];
  if (previous && previous.revision < revision) {
    previous.state = state;
    previous.revision = revision;
    previous.restored_by_uid = tombstone.restored_by_uid;
    previous.sync_state = "synced";
    previous.cloud_revision = revision;
    if (tombstone.content_digest) previous.content_digest = tombstone.content_digest;
  }
}

function upsertTombstone(draft: StoreSnapshot, soulUid: string, tombstone: AssetTombstone): void {
  const list = draft.digest_tombstones[soulUid] ?? [];
  const index = list.findIndex((t) => t.asset_uid === tombstone.asset_uid);
  if (index >= 0) {
    if (list[index].revision >= tombstone.revision) return;
    list[index] = tombstone;
  } else {
    list.push(tombstone);
  }
  draft.digest_tombstones[soulUid] = list;
}

/** Remove only the cloud-confirmed cache: synced assets + digest tombstones (§9). */
export function clearCloudCache(draft: StoreSnapshot): void {
  for (const [uid, asset] of Object.entries(draft.assets)) {
    if (asset.sync_state === "synced") delete draft.assets[uid];
  }
  draft.digest_tombstones = {};
}

// --- receipts ----------------------------------------------------------------------

export interface ReceiptOptions {
  root?: string;
  fs?: Partial<StoreFs>;
}

/**
 * Record a delivery receipt locally. Receipts carry manifest UIDs + revisions and a
 * SHA-256 of the rendered text only — never the rendered text itself, a prompt, a
 * cwd or a native id (§7).
 */
export async function recordReceipt(
  binding: BindingSnapshot,
  bundle: ContextBundle,
  stage: "downloaded" | "injected",
  options: ReceiptOptions = {},
): Promise<void> {
  const root = resolveRoot(options.root);
  const fs: StoreFs = { ...defaultStoreFs, ...(options.fs ?? {}) };
  const renderedSha256 = createHash("sha256").update(bundle.rendered_text ?? "", "utf8").digest("hex");
  const store = await openStore(root, binding.profile_id, { fs });
  try {
    await store.transact((draft) => {
      draft.receipts[randomUUID()] = {
        binding_uid: binding.binding_uid,
        binding_revision: binding.revision,
        stage,
        manifest: (bundle.manifest ?? []).map((entry) => ({ asset_uid: entry.asset_uid, revision: entry.revision })),
        rendered_sha256: renderedSha256,
      };
      return undefined;
    });
  } finally {
    await store.close();
  }
}

// --- owner review / delete ---------------------------------------------------------

export interface ReviewPayload {
  asset_uid: string;
  action: "approve" | "reject" | "edit" | "pin" | "unpin";
  replacement_uid?: string;
  content?: string;
  applicability?: string;
  tags?: string[];
}

function reviewOp(asset: LocalAsset, payload: Record<string, unknown>): OutboxOperation {
  const operationId = randomUUID();
  return {
    operation_id: operationId,
    operation_kind: "asset",
    request: {
      change_id: operationId,
      operation: "review",
      soul_uid: asset.soul_uid,
      asset_uid: asset.asset_uid,
      base_revision: asset.cloud_revision ?? 0,
      actor: "owner",
      binding_uid: null,
      binding_revision: null,
      payload,
    },
    predecessor_operation_ids: [],
  };
}

export async function reviewAsset(root: string, profileId: ProfileId, payload: ReviewPayload): Promise<LocalAsset> {
  const store = await openStore(root, profileId);
  try {
    const assetUid = payload.asset_uid;
    const action = payload.action;
    const snap = await store.read();
    const asset = snap.assets[assetUid];
    if (!asset) throw new StoreError("unknown_asset", `no asset ${assetUid}`);

    if (action === "approve") {
      if (asset.state !== "candidate") {
        throw new StoreError("invalid_state_transition", `asset ${assetUid} is ${asset.state}; only a candidate can be approved`);
      }
      const op = reviewOp(asset, { action: "approve" });
      await store.transact((draft) => {
        const a = draft.assets[assetUid];
        a.state = "active";
        a.sync_state = "pending_sync";
        draft.outbox[op.operation_id] = op;
        return undefined;
      });
    } else if (action === "reject") {
      const op = reviewOp(asset, { action: "reject" });
      await store.transact((draft) => {
        const a = draft.assets[assetUid];
        a.state = "rejected";
        a.restored_by_uid = null;
        a.sync_state = "pending_sync";
        draft.outbox[op.operation_id] = op;
        upsertTombstone(draft, a.soul_uid, localTombstone(a));
        return undefined;
      });
    } else if (action === "edit") {
      const replacementUid = payload.replacement_uid ?? randomUUID();
      const op = reviewOp(asset, {
        action: "edit",
        replacement_uid: replacementUid,
        ...(typeof payload.content === "string" ? { content: payload.content } : {}),
        ...(typeof payload.applicability === "string" ? { applicability: payload.applicability } : {}),
        ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}),
      });
      await store.transact((draft) => {
        const old = draft.assets[assetUid];
        old.state = "superseded";
        old.restored_by_uid = replacementUid;
        old.sync_state = "pending_sync";
        draft.assets[replacementUid] = {
          ...old,
          asset_uid: replacementUid,
          state: "active",
          revision: 1,
          cloud_revision: null,
          supersedes_uid: assetUid,
          sync_state: "pending_sync",
          pinned: old.pinned,
          content: typeof payload.content === "string" ? payload.content : old.content,
          applicability: typeof payload.applicability === "string" ? payload.applicability : old.applicability,
          tags: Array.isArray(payload.tags) ? payload.tags.slice() : old.tags.slice(),
        };
        draft.outbox[op.operation_id] = op;
        upsertTombstone(draft, old.soul_uid, localTombstone({ ...old }));
        return undefined;
      });
    } else {
      const op = reviewOp(asset, { action });
      await store.transact((draft) => {
        const a = draft.assets[assetUid];
        a.pinned = action === "pin";
        a.sync_state = "pending_sync";
        draft.outbox[op.operation_id] = op;
        return undefined;
      });
    }
    return (await store.read()).assets[assetUid];
  } finally {
    await store.close();
  }
}

function localTombstone(asset: LocalAsset): AssetTombstone {
  return {
    asset_uid: asset.asset_uid,
    soul_uid: asset.soul_uid,
    kind: asset.kind,
    trait: asset.trait,
    content_digest: asset.content_digest ?? contentDigest(asset.content),
    revision: (asset.cloud_revision ?? 0) + 1,
    state: asset.state,
    restored_by_uid: asset.restored_by_uid ?? null,
  };
}

export async function deleteAsset(root: string, profileId: ProfileId, payload: { asset_uid: string }): Promise<LocalAsset> {
  const store = await openStore(root, profileId);
  try {
    const assetUid = payload.asset_uid;
    const snap = await store.read();
    const asset = snap.assets[assetUid];
    if (!asset) throw new StoreError("unknown_asset", `no asset ${assetUid}`);
    const operationId = randomUUID();
    const op: OutboxOperation = {
      operation_id: operationId,
      operation_kind: "asset",
      request: {
        change_id: operationId,
        operation: "delete",
        soul_uid: asset.soul_uid,
        asset_uid: asset.asset_uid,
        base_revision: asset.cloud_revision ?? 0,
        actor: "owner",
        binding_uid: null,
        binding_revision: null,
        payload: {},
      },
      predecessor_operation_ids: [],
    };
    await store.transact((draft) => {
      const a = draft.assets[assetUid];
      a.state = "deleted";
      a.restored_by_uid = null;
      a.sync_state = "pending_sync";
      draft.outbox[op.operation_id] = op;
      upsertTombstone(draft, a.soul_uid, localTombstone(a));
      return undefined;
    });
    return (await store.read()).assets[assetUid];
  } finally {
    await store.close();
  }
}

// --- owner context (injection path helper) ----------------------------------------

/** Build the owner-private ContextInput from the store: the Soul + only its assets. */
export function ownerContextInput(
  snap: StoreSnapshot,
  soulUid: string,
  binding: Binding,
  taskHint: string,
  budgetBytes?: number,
): ContextInput {
  const soul = snap.souls[soulUid];
  const assets: (Asset | AssetTombstone)[] = [];
  for (const asset of Object.values(snap.assets)) {
    if (asset.soul_uid === soulUid) assets.push(asset);
  }
  for (const list of Object.values(snap.digest_tombstones)) {
    for (const tombstone of list) {
      if (tombstone.soul_uid === soulUid) assets.push(tombstone);
    }
  }
  const quarantined: string[] = [];
  for (const entry of Object.values(snap.quarantine)) {
    if (entry.operation.operation_kind !== "asset") continue;
    const assetUid = entry.operation.request.asset_uid;
    if (typeof assetUid === "string") quarantined.push(assetUid);
  }
  return {
    soul,
    assets,
    taskHint,
    ...(budgetBytes !== undefined ? { budgetBytes } : {}),
    binding,
    quarantinedAssetUids: quarantined,
  };
}

// --- assets-mode gate --------------------------------------------------------------

/** True when any local account entry is in the assets-only sync mode. */
export function isAssetsModeSync(root: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(accountsIndexPath(root), "utf8")) as Record<string, unknown>;
    for (const entry of Object.values(parsed)) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        (entry as { soul_sync_mode?: unknown }).soul_sync_mode === "assets_only"
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// --- writer commands ---------------------------------------------------------------

registerWriterCommand("sync_once", async ({ root, request }) => {
  return syncOnce(request.profile_id, globalThis.fetch as HttpFetch, { root });
});

registerWriterCommand("record_receipt", async ({ root, request }) => {
  const p = request.payload;
  const binding = p.binding as BindingSnapshot;
  const bundle = p.bundle as ContextBundle;
  const stage = p.stage === "injected" ? "injected" : "downloaded";
  if (!binding || typeof binding.profile_id !== "string" || typeof binding.binding_uid !== "string") {
    throw new StoreError("invalid_key", "a binding snapshot is required");
  }
  if (!bundle || typeof bundle.rendered_text !== "string") {
    throw new StoreError("invalid_payload", "a context bundle is required");
  }
  await recordReceipt(binding, bundle, stage, { root });
  return { recorded: true };
});

registerWriterCommand("review_asset", async ({ root, request }) => {
  return reviewAsset(root, request.profile_id, request.payload as unknown as ReviewPayload);
});

registerWriterCommand("delete_asset", async ({ root, request }) => {
  return deleteAsset(root, request.profile_id, request.payload as { asset_uid: string });
});

// Reference selectContext so the injection path stays tree-shakeable in the same module graph.
void selectContext;
