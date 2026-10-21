/**
 * Task 5: the cloud boundary for soul-assets/v1.
 *
 * `syncOnce` pushes the outbox and pulls the cloud directory over the injected
 * `HttpFetch` only — it never calls `globalThis.fetch`, and no transcript, prompt,
 * cwd or native session id ever appears in an HTTP body, receipt, outbox envelope
 * or log. The `sync_once` writer command's transport is injected at the composition
 * root via `configureSyncHttp` (the handler never reads `globalThis.fetch`). The
 * HTTP layer understands every §9 status (200/201/401/403/404/409/413/422/429/5xx,
 * Retry-After and bounded backoff), and distinguishes the per-change
 * `idempotency_mismatch` carried inside a 200 push from a whole-request 409 on any
 * other endpoint.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { BindingSnapshot, HttpFetch, ProfileId } from "../adapters/types.js";
import { loadConfig } from "../agentd/state.js";
import { clearDeviceCredentials, credentialForRuntime, selectCredentials, type StoredCredential } from "../agentd/credentials.js";
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
  RUNTIME_KINDS,
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

type SyncAuth = {
  root: string;
  baseUrl: string;
  backoff: Required<SyncBackoff>;
  credentials: StoredCredential[];
  defaultToken: string;
};

function tokenForRuntime(auth: SyncAuth, runtimeKind: string | null | undefined): string | null {
  const exact = credentialForRuntime(auth.credentials, runtimeKind);
  if (exact) return exact.token;
  // Test/compat override: options.token is an explicit wildcard supplied by the
  // caller, never a guessed global config token.
  return auth.credentials.find((credential) => credential.runtime_kind === "*")?.token ?? null;
}

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
      // Release the body (and the wrapper's timeout) before retrying.
      await response.body?.cancel().catch(() => {});
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
  const baseUrl = (options.baseUrl ?? config?.api_base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const store = await openStore(root, profileId, { fs });
  const report: SyncReport = { accepted: 0, conflicts: 0, pending: 0 };
  try {
    const snap = await store.read();
    // Credentials are scoped to this exact profile + owner + cloud device. The
    // legacy config.tokens map is intentionally not a fallback: it cannot prove
    // ownership, and using it is how account A used to pull account B's Soul.
    const credentials: StoredCredential[] = options.token
      ? [{
          token: options.token,
          owner_id: snap.owner_id ?? "",
          cloud_device_uid: snap.cloud_device_uid ?? "",
          runtime_kind: "*",
          profile_id: profileId,
          obtained_at: "",
        }]
      : selectCredentials(config, profileId, snap.owner_id, snap.cloud_device_uid);
    if (credentials.length === 0) {
      report.pending = pendingCount(snap);
      report.error = "no authorized device token";
      return report;
    }
    const auth: SyncAuth = {
      root,
      baseUrl,
      backoff: { ...defaultBackoff(), ...(options.backoff ?? {}) },
      credentials,
      defaultToken: credentials[0].token,
    };
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
    report.error = error instanceof StoreError ? error.code : "sync_failed";
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
  // Group by the runtime that produced the asset so a Claude Code token is never
  // used to replay a Codex/OpenCode/Hermes proposal (Rails checks token runtime).
  snap = await store.read();
  const assetOps = orderOutboxOps(Object.values(snap.outbox)).filter((op) => op.operation_kind === "asset");
  const groups = new Map<string | null, OutboxOperation[]>();
  for (const op of assetOps) {
    // F1: an asset for a Soul the user has not explicitly authorized stays in
    // the outbox (local-only) and must not block Pull for an authorized Soul.
    const assetKind = opKind(snap, op);
    const assetSoul = String(op.request.soul_uid ?? "");
    if (assetKind === null || !authorizedCategories(snap, assetSoul).has(assetKind)) continue;
    const runtime = assetRuntime(snap, op);
    const list = groups.get(runtime) ?? [];
    list.push(op);
    groups.set(runtime, list);
  }
  for (const [runtime, ops] of groups) {
    const token = runtime ? tokenForRuntime(auth, runtime) : auth.defaultToken;
    if (!token) return "credential_unavailable";
    for (const batch of batchAssetOps(ops)) {
      const current = await store.read();
      const live = batch.filter((op) => current.outbox[op.operation_id]);
      if (live.length === 0) continue;
      const outcome = await pushAssetBatch(store, http, auth, report, live, token);
      if (outcome) return outcome;
    }
  }
  return null;
}

/** The runtime that produced an asset op: source metadata first, binding fallback. */
function assetRuntime(snap: StoreSnapshot, op: OutboxOperation): string | null {
  const payload = op.request.payload as { source?: { runtime_kind?: unknown } } | undefined;
  const sourceRuntime = payload?.source?.runtime_kind;
  if (typeof sourceRuntime === "string" && (RUNTIME_KINDS as readonly string[]).includes(sourceRuntime)) {
    return sourceRuntime;
  }
  const bindingUid = op.request.binding_uid;
  if (typeof bindingUid === "string") {
    const binding = Object.values(snap.bindings).find((candidate) => candidate.binding_uid === bindingUid);
    if (binding) return binding.runtime_kind;
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
  if (op.operation_kind === "binding") {
    // F1: never send a binding for a Soul without an enabled identity Consent.
    // The local binding/outbox entry is retained; explicit authorization will
    // make it sendable on a later run, after register/consent replay.
    const soulUid = String(op.request.soul_uid ?? "");
    if (!authorizedCategories(snap, soulUid).has("identity")) return null;
  }
  let token = auth.defaultToken;
  if (op.operation_kind === "binding") {
    const runtimeKind = String(op.request.runtime_kind ?? "");
    const scoped = tokenForRuntime(auth, runtimeKind);
    if (!scoped) return "credential_unavailable";
    token = scoped;
  }
  const headers = authHeaders(token);
  switch (op.operation_kind) {
    case "register_soul": {
      const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/souls`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": op.operation_id },
        body: JSON.stringify(op.request),
      }, auth);
      return handleRegisterSoul(store, snap, op, res, report, auth.root);
    }
    case "consent": {
      const soulUid = String(op.request.soul_uid ?? "");
      const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/souls/${encodeURIComponent(soulUid)}/consent`, {
        method: "PUT",
        headers: { ...headers, "idempotency-key": op.operation_id },
        body: JSON.stringify(consentBody(op.request)),
      }, auth);
      return handleConsent(store, snap, op, res, report, auth.root);
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
      // A rebind that inherited a local revision from a predecessor that never
      // reached the cloud (e.g. it was an unauthorized Soul) would CAS against 0
      // and be permanently quarantined as revision_conflict. Park it with the
      // actionable same contract instead of sending an invalid request.
      if ((binding.cloud_revision ?? 0) === 0 && Number(op.request.base_revision ?? 0) > 0) {
        return quarantineOp(store, op, "needs_new_session", report, null);
      }
      const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/bindings/${encodeURIComponent(binding.binding_uid)}`, {
        method: "PUT",
        headers: { ...headers, "idempotency-key": op.operation_id },
        body: JSON.stringify(op.request),
      }, auth);
      return handleBinding(store, snap, op, res, report, auth.root);
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
  root: string,
): Promise<string | null> {
  const soulUid = String(op.request.soul_uid ?? "");
  if (res.status === 200 || res.status === 201) {
    const body = res.body as { soul?: Soul; consent?: Consent } | null;
    await store.transact((draft) => {
      delete draft.outbox[op.operation_id];
      if (body?.soul) {
        const previous = draft.souls[soulUid];
        draft.souls[soulUid] = {
          ...previous,
          ...body.soul,
          // A locally created Soul keeps its local original identity even after the
          // server confirms/updates it.
          ...(previous?.origin === "local"
            ? {
            origin: "local" as const,
            local_identity: previous.local_identity ?? previous.identity,
            local_identity_revision: previous.local_identity_revision ?? previous.identity_revision,
          }
            : { origin: "cloud" as const }),
        };
      }
      if (body?.consent) {
        const key = consentKey(body.consent.cloud_device_uid, body.consent.soul_uid);
        const previous = draft.consents[key];
        draft.consents[key] = body.consent;
        // First explicit registration resets the pull cursor once (§6).
        if ((previous?.revision ?? 0) < body.consent.revision) draft.pull_cursor = "0";
        // An enabled consent immediately rescues still-valid local_only assets
        // extracted while consent was off (Ruling 8) — but only when the consent
        // actually moved state forward, never on a same-revision replay.
        if ((previous?.revision ?? 0) < body.consent.revision || previous === undefined) {
          enqueueAuthorizedLocalAssets(draft, body.consent);
        }
      }
      return undefined;
    });
    report.accepted += 1;
    return null;
  }
  if (res.status === 409) {
    return quarantineOp(store, op, stopCode(res.body).code, report, null);
  }
  if (res.status === 404) {
    return quarantineOp(store, op, "not_found", report, null);
  }
  if (res.status === 422) {
    // Old snapshots enqueued register_soul with consent_categories:[] before the
    // explicit authorization entry existed. Park it with a clear reason; the user
    // can re-run `37soul soul authorize` with a fresh operation/change id.
    return quarantineOp(store, op, "authorization_required", report, null);
  }
  if (res.status === 401) return handleRevokedOrRejected(store, snap, res, root);
  return fatalFromStatus(res);
}

async function handleConsent(
  store: LocalStore,
  snap: StoreSnapshot,
  op: OutboxOperation,
  res: JsonResponse,
  report: SyncReport,
  root: string,
): Promise<string | null> {
  if (res.status === 200 || res.status === 201) {
    const body = res.body as { consent?: Consent; replay_from?: string } | null;
    await store.transact((draft) => {
      delete draft.outbox[op.operation_id];
      if (body?.consent) {
        const key = consentKey(body.consent.cloud_device_uid, body.consent.soul_uid);
        const previous = draft.consents[key];
        const revisionIncreased = (previous?.revision ?? 0) < body.consent.revision;
        draft.consents[key] = body.consent;
        // Consent PUT may carry replay_from="0" after a server-side change; a cursor
        // reset is applied once per new consent revision (§4/§6).
        if (revisionIncreased || (body.replay_from !== undefined && previous === undefined)) {
          draft.pull_cursor = "0";
        }
        const removed = removedCategoriesOrAll(previous, body.consent);
        if (removed.length > 0) revokeConsentLocal(draft, body.consent, removed);
        // Enqueue only when the consent actually moved state forward; a same-revision
        // replay must not re-enqueue an asset of a now-revoked category.
        if (revisionIncreased || previous === undefined) {
          enqueueAuthorizedLocalAssets(draft, body.consent);
        }
      }
      return undefined;
    });
    report.accepted += 1;
    return null;
  }
  if (res.status === 409) return quarantineOp(store, op, stopCode(res.body).code, report, null);
  if (res.status === 422) {
    return quarantineOp(store, op, "authorization_required", report, null);
  }
  if (res.status === 401) return handleRevokedOrRejected(store, snap, res, root);
  return fatalFromStatus(res);
}

async function handleBinding(
  store: LocalStore,
  snap: StoreSnapshot,
  op: OutboxOperation,
  res: JsonResponse,
  report: SyncReport,
  root: string,
): Promise<string | null> {
  if (res.status === 200 || res.status === 201) {
    const body = res.body as { binding?: Binding } | null;
    await store.transact((draft) => {
      delete draft.outbox[op.operation_id];
      if (body?.binding) applyBindingRecord(draft, body.binding, "ack");
      return undefined;
    });
    report.accepted += 1;
    return null;
  }
  if (res.status === 409) return quarantineOp(store, op, stopCode(res.body).code, report, null);
  if (res.status === 401) return handleRevokedOrRejected(store, snap, res, root);
  return fatalFromStatus(res);
}

/** 401 device_revoked clears downloaded cloud cache; other fatal statuses stop the run. */
async function handleRevokedOrRejected(
  store: LocalStore,
  snap: StoreSnapshot,
  res: JsonResponse,
  root: string,
): Promise<string | null> {
  const { code } = stopCode(res.body);
  if (code === "device_revoked") {
    await store.transact((draft) => clearCloudCache(draft, { revokeDevice: true }));
    await clearDeviceCredentials(root, snap.owner_id, snap.cloud_device_uid);
    return "device_revoked";
  }
  if (code === "token_invalid") {
    // A revoked/expired token is not usable for cloud access. Treat it like device
    // revocation: drop downloaded private cache and the scoped credentials, keep
    // local originals, and require a fresh login. (Rails currently reports a revoked
    // device as token_invalid because the PAT lookup happens first.)
    await store.transact((draft) => clearCloudCache(draft, { revokeDevice: true }));
    await clearDeviceCredentials(root, snap.owner_id, snap.cloud_device_uid);
    return "token_invalid";
  }
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
  token: string,
): Promise<string | null> {
  const changes = ops.map((op) => op.request);
  const res = await requestJson(http, `${auth.baseUrl}${ROUTES}/push`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ protocol: "soul-assets/v1", changes }),
  }, auth);

  if (res.status !== 200) {
    if (res.status === 401) {
      const snap = await store.read();
      return handleRevokedOrRejected(store, snap, res, auth.root);
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
      headers: authHeaders(auth.defaultToken),
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
    if (res.status === 401) return handleRevokedOrRejected(store, snap, res, auth.root);
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
        if (outcome.removed.length > 0) revokeConsentLocal(draft, consent, outcome.removed);
        // Only a consent that actually moved state forward (new revision or first
        // sight) rescues still-valid local_only assets. A stale/no-op replay must
        // not re-enqueue an asset of a now-revoked category.
        if (outcome.reset) enqueueAuthorizedLocalAssets(draft, consent);
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

/** Old snapshots predate `origin`: an unregistered Soul (no legacy_host_id) is local. */
function isLocalSoul(soul: Soul | undefined): boolean {
  if (!soul) return false;
  return soul.origin === "local" || (soul.origin === undefined && soul.legacy_host_id === null);
}

function consentKey(cloudDeviceUid: string, soulUid: string): string {
  return `${cloudDeviceUid}:${soulUid}`;
}

/** Categories removed by a consent update (a full replacement, not a delta). */
function removedCategories(previous: Consent, next: Consent): string[] {
  if (!next.enabled) return [...previous.categories];
  const nextSet = new Set(next.categories);
  return previous.categories.filter((category) => !nextSet.has(category));
}

/** First-sight disabled consent must clear any pre-existing cloud cache too. */
function removedCategoriesOrAll(previous: Consent | undefined, next: Consent): string[] {
  if (previous) return removedCategories(previous, next);
  return next.enabled ? [] : ["identity", "relationship", "experience"];
}

/** Categories the current device is authorized to sync for a Soul (empty when none). */
function authorizedCategories(snap: StoreSnapshot, soulUid: string): Set<string> {
  if (!snap.cloud_device_uid) return new Set<string>();
  const consent = snap.consents[consentKey(snap.cloud_device_uid, soulUid)];
  if (!consent?.enabled) return new Set<string>();
  return new Set(consent.categories);
}

/** The asset kind an outbox asset op touches (payload.kind, else the local asset). */
function opKind(draft: StoreSnapshot, op: OutboxOperation): string | null {
  const payload = op.request.payload as { kind?: unknown } | undefined;
  if (typeof payload?.kind === "string") return payload.kind;
  const assetUid = op.request.asset_uid;
  if (typeof assetUid === "string") {
    const kind = draft.assets[assetUid]?.kind;
    if (typeof kind === "string") return kind;
  }
  return null;
}

/**
 * Consent turned on (or widened): work extracted while consent was off is no longer
 * stranded. Walk the Soul's still-valid local-only assets and enqueue one propose per
 * newly-authorized category. The operation_id is deterministic (asset_uid + revision)
 * so a replayed enable writes the same outbox key instead of duplicating.
 */
function enqueueAuthorizedLocalAssets(draft: StoreSnapshot, consent: Consent): void {
  if (!consent.enabled) return;
  const authorized = new Set(consent.categories);
  // A content digest the cloud has already dismissed (deleted/rejected/superseded
  // from any device) must stay local_only — never re-propose a fact the person
  // already removed elsewhere.
  const dismissed = new Set<string>();
  for (const list of Object.values(draft.digest_tombstones)) {
    for (const tombstone of list) {
      if (typeof tombstone.content_digest === "string" && tombstone.content_digest) {
        dismissed.add(tombstone.content_digest);
      }
    }
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const asset of Object.values(draft.assets)) {
    if (asset.soul_uid !== consent.soul_uid) continue;
    // The change_id must be a UUID; legacy non-UUID local ids stay local_only.
    if (!UUID_RE.test(asset.asset_uid)) continue;
    if (asset.sync_state !== "local_only") continue;
    if (asset.state !== "active" && asset.state !== "candidate") continue;
    if (!authorized.has(asset.kind)) continue;
    const digest = typeof asset.content_digest === "string" && asset.content_digest
      ? asset.content_digest
      : contentDigest(asset.content);
    if (dismissed.has(digest)) continue;

    // R6: a re-authorized asset keeps the binding it was extracted under. A new
    // default Soul/binding must never revive an old proposal, and actor=owner is
    // not an acceptable shortcut around the model-binding check.
    const binding = asset.binding_uid
      ? Object.values(draft.bindings).find((candidate) => candidate.binding_uid === asset.binding_uid)
      : undefined;
    const validBinding =
      binding !== undefined &&
      binding.soul_uid === asset.soul_uid &&
      binding.state === "bound" &&
      binding.revision === asset.binding_revision;
    const op = localAssetProposeOp(asset, validBinding ? binding : null);
    if (!validBinding) {
      asset.sync_state = "conflict";
      draft.quarantine[`local-binding:${asset.asset_uid}`] = {
        operation: op,
        reason: "binding_stale",
      };
      continue;
    }
    asset.sync_state = "pending_sync";
    draft.outbox[op.operation_id] = op;
  }
}

/** Build a propose op with a stable UUID change_id and the frozen binding provenance. */
function localAssetProposeOp(
  asset: LocalAsset,
  binding: BindingSnapshot | null,
): OutboxOperation {
  return {
    // The asset UUID is stable across re-authorization, already a UUID, and unique.
    operation_id: asset.asset_uid,
    operation_kind: "asset",
    request: {
      change_id: asset.asset_uid,
      operation: "propose",
      soul_uid: asset.soul_uid,
      asset_uid: asset.asset_uid,
      base_revision: 0,
      actor: "model",
      binding_uid: binding?.binding_uid ?? asset.binding_uid ?? null,
      binding_revision: binding?.revision ?? asset.binding_revision ?? null,
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

interface ConsentOutcome {
  reset: boolean;
  removed: string[];
}

/** Returns reset=true when the revision strictly increased (cursor reset once);
 *  revoked=true when a known Consent narrowed (disabled or a category removed). */
function applyConsentEvent(draft: StoreSnapshot, consent: Consent): ConsentOutcome {
  if (!consent?.cloud_device_uid || !consent?.soul_uid) return { reset: false, removed: [] };
  const key = consentKey(consent.cloud_device_uid, consent.soul_uid);
  const previous = draft.consents[key];
  if (previous && consent.revision <= previous.revision) return { reset: false, removed: [] };
  draft.consents[key] = consent;
  const reset = (previous?.revision ?? 0) < consent.revision;
  const removed = removedCategoriesOrAll(previous, consent);
  return { reset, removed };
}

/** Consent narrowed: drop the Soul's cloud-confirmed cache of the removed categories,
 *  keep local originals, and park only the pending asset sends whose category is no
 *  longer authorized (§2.4 / consent_control_event). */
function revokeConsentLocal(draft: StoreSnapshot, consent: Consent, removed: string[]): void {
  const soulUid = consent.soul_uid;
  const authorized = consent.enabled ? new Set(consent.categories) : new Set<string>();
  if (removed.includes("identity")) {
    const soul = draft.souls[soulUid];
    if (soul) {
      if (isLocalSoul(soul)) {
        // Local original survives; its cloud identity is no longer injected.
        soul.identity = { ...(soul.local_identity ?? soul.identity) };
        soul.identity_revision = soul.local_identity_revision ?? soul.identity_revision;
      } else {
        delete draft.souls[soulUid];
      }
    }
  }
  for (const [uid, asset] of Object.entries(draft.assets)) {
    if (asset.soul_uid !== soulUid) continue;
    if (asset.sync_state === "synced" && !authorized.has(asset.kind)) delete draft.assets[uid];
  }
  for (const key of Object.keys(draft.digest_tombstones)) {
    draft.digest_tombstones[key] = draft.digest_tombstones[key].filter(
      (t) => t.soul_uid !== soulUid || authorized.has(t.kind),
    );
  }
  for (const [opId, op] of Object.entries(draft.outbox)) {
    if (op.operation_kind !== "asset") continue;
    if (op.request.soul_uid !== soulUid) continue;
    const kind = opKind(draft, op);
    if (kind !== null && authorized.has(kind)) continue; // still-authorized category stays sendable
    delete draft.outbox[opId];
    draft.quarantine[opId] = { operation: op, reason: "consent_revoked" };
  }
}

function applySoulEvent(draft: StoreSnapshot, soul: Soul): void {
  if (!soul?.soul_uid) return;
  const previous = draft.souls[soul.soul_uid];
  if (previous && previous.identity_revision >= soul.identity_revision) return;
  const local = isLocalSoul(previous);
  draft.souls[soul.soul_uid] = {
    soul_uid: soul.soul_uid,
    legacy_host_id: soul.legacy_host_id ?? null,
    identity_revision: soul.identity_revision,
    identity: { ...soul.identity },
    state: "active",
    origin: local ? "local" : "cloud",
    ...(local
      ? {
          local_identity: previous?.local_identity ?? previous?.identity,
          local_identity_revision: previous?.local_identity_revision ?? previous?.identity_revision,
        }
      : {}),
  };
}

function applyBindingRecord(draft: StoreSnapshot, binding: Binding, mode: "cloud" | "ack" = "cloud"): void {
  if (!binding?.binding_uid) return;
  for (const key of Object.keys(draft.bindings)) {
    const existing = draft.bindings[key];
    if (existing.binding_uid !== binding.binding_uid) continue;

    if (mode === "ack" && existing.unconfirmed === true && existing.revision > binding.revision) {
      // An earlier ACK (e.g. bound/rev1) must not overwrite a newer local intent
      // (detach/switch/rev2) that is still queued. Advance only the confirmed
      // watermark; keep the current local record usable for "is it detached?".
      draft.bindings[key] = {
        ...existing,
        cloud_revision: Math.max(existing.cloud_revision ?? 0, binding.revision),
      };
      return;
    }

    if (existing.cloud_revision == null && existing.unconfirmed == null) {
      // Legacy snapshot: no confirmed/local split is recorded. Refuse a downgrade,
      // but let an equal/higher cloud record win so a server-side detach is honored.
      if (binding.revision < existing.revision) return;
    } else {
      const confirmedRevision = existing.cloud_revision ?? existing.revision;
      if (binding.revision < confirmedRevision) return;
      // Pull/control events may confirm a same-revision cloud state; they must win
      // over an unconfirmed local mutation (R7). An ACK at the same revision simply
      // confirms the current local state.
      if (binding.revision === confirmedRevision && existing.unconfirmed !== true && mode === "cloud") return;
    }
    draft.bindings[key] = {
      ...existing,
      ...binding,
      cloud_revision: binding.revision,
      unconfirmed: false,
    };
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

/**
 * Remove only the cloud-confirmed cache (§9): synced assets, tombstones, cloud-origin
 * Souls, device Consents and bindings. Local originals and local_only assets stay.
 * Pending outbound operations for this revoked device are parked in quarantine so a
 * background retry can never reuse the revoked credentials.
 */
export function clearCloudCache(draft: StoreSnapshot, options: { revokeDevice?: boolean } = {}): void {
  for (const [uid, asset] of Object.entries(draft.assets)) {
    if (asset.sync_state === "synced") delete draft.assets[uid];
  }
  draft.digest_tombstones = {};
  if (options.revokeDevice !== true) return;
  for (const [uid, soul] of Object.entries(draft.souls)) {
    if (isLocalSoul(soul)) {
      soul.identity = { ...(soul.local_identity ?? soul.identity) };
      soul.identity_revision = soul.local_identity_revision ?? soul.identity_revision;
    } else {
      delete draft.souls[uid];
    }
  }
  for (const [key, consent] of Object.entries(draft.consents)) {
    if (consent.cloud_device_uid === draft.cloud_device_uid) {
      draft.consents[key] = { ...consent, enabled: false, categories: [] };
    }
  }
  for (const [key, binding] of Object.entries(draft.bindings)) {
    if (binding.device_id !== draft.device_id) continue;
    if (binding.state === "bound") {
      draft.bindings[key] = {
        ...binding,
        state: "detached",
        revision: binding.revision + 1,
        cloud_revision: binding.cloud_revision ?? binding.revision,
        unconfirmed: false,
      };
    }
  }
  for (const [opId, op] of Object.entries(draft.outbox)) {
    if (op.operation_kind === "asset" || op.operation_kind === "consent" || op.operation_kind === "binding") {
      delete draft.outbox[opId];
      draft.quarantine[opId] = { operation: op, reason: "device_revoked" };
    }
  }
  draft.pull_cursor = null;
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
  const authorized = authorizedCategories(snap, soulUid);
  const identityAuthorized = authorized.has("identity");
  const hasConsentRecord = Object.values(snap.consents).some((consent) => consent.soul_uid === soulUid);
  let contextSoul: Soul;
  if (identityAuthorized) {
    if (!soul) throw new StoreError("identity_not_authorized", `no authorized soul ${soulUid}`);
    contextSoul = soul;
  } else if (isLocalSoul(soul) && soul) {
    // Anonymous/local original still works offline; a downloaded cloud identity does not.
    contextSoul = {
      ...soul,
      identity: { ...(soul.local_identity ?? soul.identity) },
      identity_revision: soul.local_identity ? (soul.local_identity_revision ?? soul.identity_revision) : soul.identity_revision,
    };
  } else {
    throw new StoreError("identity_not_authorized", `identity consent is not active for ${soulUid}`);
  }

  const localFallback = !hasConsentRecord || isLocalSoul(contextSoul);
  const mayUse = (kind: string, syncState?: string): boolean => {
    if (authorized.has(kind)) return true;
    return localFallback && (syncState === "local_only" || syncState === "conflict");
  };

  const assets: (Asset | AssetTombstone)[] = [];
  for (const asset of Object.values(snap.assets)) {
    if (asset.soul_uid !== soulUid) continue;
    if (!mayUse(asset.kind, asset.sync_state)) continue;
    assets.push(asset);
  }
  for (const list of Object.values(snap.digest_tombstones)) {
    for (const tombstone of list) {
      if (tombstone.soul_uid !== soulUid) continue;
      if (!authorized.has(tombstone.kind)) continue;
      assets.push(tombstone);
    }
  }

  const quarantined: string[] = [];
  for (const entry of Object.values(snap.quarantine)) {
    if (entry.operation.operation_kind !== "asset") continue;
    const assetUid = entry.operation.request.asset_uid;
    if (typeof assetUid !== "string") continue;
    // Only an unconfirmed local proposal may be excluded. A conflict entry for a UID
    // whose current object is a confirmed cloud copy must not hide that copy (R9).
    const current = snap.assets[assetUid];
    const confirmed = current && current.sync_state === "synced" && current.cloud_revision !== null;
    if (!confirmed) quarantined.push(assetUid);
  }
  return {
    soul: contextSoul,
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

/**
 * The writer's sync transport, injected at the composition root. The `sync_once`
 * handler never reads `globalThis.fetch`: an unconfigured writer fails with a typed
 * `http_not_configured` error instead of silently falling back to the process fetch.
 */
let syncHttp: HttpFetch | null = null;

/** Composition-root injection point for the `sync_once` writer transport. */
export function configureSyncHttp(fetch: HttpFetch | null): void {
  syncHttp = fetch;
}

export const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
export const SYNC_TIMEOUT_MIN_MS = 1_000;
export const SYNC_TIMEOUT_MAX_MS = 60_000;

/**
 * One bounded request: a fresh AbortController per call. The timer stays armed
 * until the response body is fully consumed (not merely until headers arrive), then
 * is cleared by the wrapped body/json/text methods. The bound lives here — in the
 * process that executes the writer command — so a resident daemon (agentd) that runs
 * `sync_once` on its own fetch is protected too, not just the caller that dispatched
 * the command.
 */
export function withTimeout(http: HttpFetch, timeoutMs: number): HttpFetch {
  return async (input, init = {}) => {
    const controller = new AbortController();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = (await http(input, { ...init, signal: controller.signal })) as unknown as FetchResponseLike;
      // Keep the timer alive until the complete body is consumed. A server that
      // flushes headers and then stalls must still hit the deadline (R5).
      return boundedResponse(response, finish) as unknown as Response;
    } catch (error) {
      finish();
      throw error;
    }
  };
}

function boundedResponse(response: FetchResponseLike, finish: () => void): FetchResponseLike {
  const consume = <T>(fn: (() => Promise<T>) | undefined): (() => Promise<T>) => async () => {
    try {
      if (!fn) throw new Error("response body is not readable");
      return await fn();
    } finally {
      finish();
    }
  };
  const wrapped: FetchResponseLike = {
    status: response.status,
    headers: response.headers,
    json: consume(response.json.bind(response)),
    body: response.body ? { cancel: consume(response.body.cancel.bind(response.body)) } : null,
  };
  const text = (response as unknown as { text?: () => Promise<string> }).text;
  if (typeof text === "function") {
    (wrapped as unknown as { text: () => Promise<string> }).text = consume(text.bind(response));
  }
  return wrapped;
}

/**
 * Resolve an optional `timeout_ms` from a writer payload: an integer is clamped to
 * [SYNC_TIMEOUT_MIN_MS, SYNC_TIMEOUT_MAX_MS]; anything absent or not an integer
 * falls back to DEFAULT_SYNC_TIMEOUT_MS.
 */
export function clampSyncTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_SYNC_TIMEOUT_MS;
  return Math.min(SYNC_TIMEOUT_MAX_MS, Math.max(SYNC_TIMEOUT_MIN_MS, value));
}

registerWriterCommand("sync_once", async ({ root, request }) => {
  // The legacy transcript mode can never push the new store: refuse before any
  // network work when no local account entry is in assets-only sync mode.
  if (!isAssetsModeSync(root)) {
    return { accepted: 0, conflicts: 0, pending: 0, error: "assets mode is not enabled" };
  }
  if (!syncHttp) {
    throw new StoreError("http_not_configured", "no HTTP transport was configured for the writer");
  }
  return syncOnce(request.profile_id, withTimeout(syncHttp, clampSyncTimeoutMs(request.payload?.timeout_ms)), { root });
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
