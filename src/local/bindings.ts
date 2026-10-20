/**
 * Task 3: offline Souls, versioned session bindings, and the resolution chain.
 *
 * Bindings are one record per native session key
 * `(profile_id, device_id, runtime_kind, native_session_id)`. `native_session_id`
 * and any local path never leave the machine: the cloud-facing session identity is
 * the random, persisted `session_ref`, and the outbox binding operation carries the
 * CAS request `{ base_revision, session_ref, runtime_kind, soul_uid, state }` —
 * never the native id.
 *
 * Every bind / switch / detach:
 *   - mutates the *same* binding record and bumps `revision` (base 0 -> 1 -> 2 ...);
 *   - appends an immutable outbox operation with a fresh `operation_id`
 *     (Idempotency-Key) whose `predecessor_operation_ids` link it to the previous
 *     binding operation, and whose `request` is the original frozen CAS request.
 * The operations are never flattened or rewritten, so an offline replay re-applies
 * base 0 -> rev 1 -> rev 2 in order, and a result frozen at an old revision is
 * recognizably stale.
 *
 * `resolveBinding` is the SessionStart query. Order:
 *   1. session explicit choice (explicitSoulUid),
 *   2. native binding,
 *   3. tool default,
 *   4. account default,
 *   5. unique Soul,
 *   6. refuse to guess (never cwd / title / character name).
 * A session with no native id is refused outright — there is nothing stable to key
 * a binding on, so nothing is guessed.
 *
 * Tool default / account default live in the profile's 0600 `defaults.json` (a
 * sibling of device.json), not in the fixed §2.5 snapshot.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Binding, RuntimeKind, Soul } from "../assets/protocol.js";
import type { BindingSnapshot, NativeSessionKey } from "../adapters/types.js";
import {
  defaultStoreFs,
  openStore,
  profileDir,
  StoreError,
  type OutboxOperation,
  type StoreSnapshot,
} from "./store.js";
import { registerWriterCommand } from "./writer.js";
import { mergeLoginProfile, readAccountsIndex, resolveRoot, writeAccountsIndex, type LocalOptions } from "./profiles.js";

/** Join the native key into one record key. Never serialized beyond the local store. */
export function bindingKey(key: NativeSessionKey): string {
  return [key.profile_id, key.device_id, key.runtime_kind, key.native_session_id].join("\u0000");
}

function toBinding(binding: BindingSnapshot): Binding {
  return {
    binding_uid: binding.binding_uid,
    session_ref: binding.session_ref,
    runtime_kind: binding.runtime_kind,
    soul_uid: binding.soul_uid,
    revision: binding.revision,
    state: binding.state,
  };
}

function createBinding(key: NativeSessionKey, soulUid: string): BindingSnapshot {
  return {
    binding_uid: randomUUID(),
    session_ref: randomUUID(), // random + persisted; this is the only cloud-facing session identity
    runtime_kind: key.runtime_kind,
    soul_uid: soulUid,
    revision: 1,
    state: "bound",
    profile_id: key.profile_id,
    device_id: key.device_id,
    native_session_id: key.native_session_id,
  };
}

function bindingOutboxOp(
  binding: BindingSnapshot,
  state: "bound" | "detached",
  baseRevision: number,
  predecessorOperationIds: string[],
): OutboxOperation {
  return {
    operation_id: randomUUID(),
    operation_kind: "binding",
    // The original frozen CAS request; never rewritten, never carries the native id.
    request: {
      base_revision: baseRevision,
      session_ref: binding.session_ref,
      runtime_kind: binding.runtime_kind,
      soul_uid: binding.soul_uid,
      state,
    },
    predecessor_operation_ids: predecessorOperationIds,
  };
}

/** The most recent outbox binding operation for a session_ref (the predecessor). */
function lastBindingOpId(snap: StoreSnapshot, sessionRef: string): string | null {
  let last: string | null = null;
  for (const op of Object.values(snap.outbox)) {
    if (op.operation_kind !== "binding") continue;
    const request = op.request as { session_ref?: unknown };
    if (request.session_ref === sessionRef) last = op.operation_id;
  }
  return last;
}

/** A binding was injected once a receipt exists for it at stage "injected". */
function isInjected(snap: StoreSnapshot, binding: BindingSnapshot): boolean {
  return Object.values(snap.receipts).some(
    (receipt) => receipt.binding_uid === binding.binding_uid && receipt.stage === "injected",
  );
}

function assertNativeKey(key: NativeSessionKey): void {
  if (typeof key.native_session_id !== "string" || key.native_session_id.length === 0) {
    throw new StoreError("invalid_key", "native_session_id is required to bind a session");
  }
  if (typeof key.profile_id !== "string" || key.profile_id.length === 0) {
    throw new StoreError("invalid_key", "profile_id is required to bind a session");
  }
  if (typeof key.device_id !== "string" || key.device_id.length === 0) {
    throw new StoreError("invalid_key", "device_id is required to bind a session");
  }
}

// --- soul-selection defaults (tool default + account default) ----------------------

export interface SoulDefaults {
  tool_defaults: Partial<Record<RuntimeKind, string>>;
  account_default_soul_uid: string | null;
}

export function defaultsPath(root: string, profileId: string): string {
  return path.join(profileDir(root, profileId), "defaults.json");
}

async function readDefaults(root: string, profileId: string): Promise<SoulDefaults> {
  try {
    const raw = await readFile(defaultsPath(root, profileId), "utf8");
    const parsed = JSON.parse(raw) as Partial<SoulDefaults>;
    return {
      tool_defaults:
        parsed.tool_defaults && typeof parsed.tool_defaults === "object" ? parsed.tool_defaults : {},
      account_default_soul_uid:
        typeof parsed.account_default_soul_uid === "string" ? parsed.account_default_soul_uid : null,
    };
  } catch {
    return { tool_defaults: {}, account_default_soul_uid: null };
  }
}

async function writeDefaults(root: string, profileId: string, defaults: SoulDefaults): Promise<void> {
  await mkdir(profileDir(root, profileId), { recursive: true, mode: 0o700 });
  const target = defaultsPath(root, profileId);
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export async function setToolDefault(
  key: { profile_id: string; runtime_kind: RuntimeKind },
  soulUid: string,
  opts: LocalOptions = {},
): Promise<void> {
  const root = resolveRoot(opts.root);
  const defaults = await readDefaults(root, key.profile_id);
  defaults.tool_defaults[key.runtime_kind] = soulUid;
  await writeDefaults(root, key.profile_id, defaults);
}

export async function setAccountDefaultSoul(
  profileId: string,
  soulUid: string | null,
  opts: LocalOptions = {},
): Promise<void> {
  const root = resolveRoot(opts.root);
  const defaults = await readDefaults(root, profileId);
  defaults.account_default_soul_uid = soulUid;
  await writeDefaults(root, profileId, defaults);
}

// --- resolution chain --------------------------------------------------------------

async function pickSoul(
  root: string,
  snap: StoreSnapshot,
  key: NativeSessionKey,
): Promise<string | null> {
  const defaults = await readDefaults(root, key.profile_id);
  // 1. tool default
  const toolDefault = defaults.tool_defaults[key.runtime_kind];
  if (toolDefault && snap.souls[toolDefault]) return toolDefault;
  // 2. account default
  if (defaults.account_default_soul_uid && snap.souls[defaults.account_default_soul_uid]) {
    return defaults.account_default_soul_uid;
  }
  // 3. unique Soul
  const souls = Object.values(snap.souls);
  if (souls.length === 1) return souls[0].soul_uid;
  // 4. refuse to guess
  return null;
}

type LocalStore = Awaited<ReturnType<typeof openStore>>;

/** Persist a mutation of an existing binding record (switch / re-bind), revision + 1. */
async function rebindExisting(
  store: LocalStore,
  snap: StoreSnapshot,
  k: string,
  existing: BindingSnapshot,
  soulUid: string,
): Promise<BindingSnapshot> {
  const pred = lastBindingOpId(snap, existing.session_ref);
  const next: BindingSnapshot = {
    ...existing,
    soul_uid: soulUid,
    state: "bound",
    revision: existing.revision + 1,
  };
  const op = bindingOutboxOp(next, "bound", existing.revision, pred ? [pred] : []);
  const written = await store.transact((draft) => {
    draft.bindings[k] = next;
    draft.outbox[op.operation_id] = op;
  });
  return written.bindings[k];
}

/** Persist a fresh binding (revision 1) for a session key. */
async function bindFresh(
  store: LocalStore,
  k: string,
  key: NativeSessionKey,
  soulUid: string,
): Promise<BindingSnapshot> {
  const binding = createBinding(key, soulUid);
  const op = bindingOutboxOp(binding, "bound", 0, []);
  const written = await store.transact((draft) => {
    draft.bindings[k] = binding;
    draft.outbox[op.operation_id] = op;
  });
  return written.bindings[k];
}

/**
 * Resolve the effective binding for a native session, or null.
 *
 * Order (explicit first, per review fix 1):
 *   1. session explicit choice (explicitSoulUid):
 *      - unknown local UID -> null, and defaults are never consulted (fix 5);
 *      - existing bound binding to the same Soul -> returned as-is;
 *      - existing bound binding to a different Soul, not injected -> re-pointed
 *        through the same revision-bump/CAS path `selectSoul` uses;
 *      - existing bound binding to a different Soul, injected -> null WITHOUT
 *        touching the stored binding (caller then calls `selectSoul`, which yields
 *        `needs_new_session`);
 *      - no bound binding -> fresh binding to the explicit Soul.
 *   2. native binding, 3. tool default, 4. account default, 5. unique Soul,
 *   6. refuse to guess. No native id => refuse to guess.
 */
export async function resolveBinding(
  key: NativeSessionKey,
  explicitSoulUid?: string,
  opts: LocalOptions = {},
): Promise<BindingSnapshot | null> {
  const root = resolveRoot(opts.root);
  if (typeof key.native_session_id !== "string" || key.native_session_id.length === 0) {
    return null; // no stable session identity: refuse to guess
  }
  const fs = { ...defaultStoreFs, ...(opts.fs ?? {}) };
  const store = await openStore(root, key.profile_id, { fs });
  try {
    const snap = await store.read();
    const k = bindingKey(key);
    const existing = snap.bindings[k];

    // 1. session explicit choice is consulted before the native binding.
    if (explicitSoulUid) {
      if (!snap.souls[explicitSoulUid]) return null; // unknown explicit UID: never guess
      if (existing && existing.state === "bound") {
        if (existing.soul_uid === explicitSoulUid) return existing;
        if (isInjected(snap, existing)) return null; // do not touch an injected session
        return rebindExisting(store, snap, k, existing, explicitSoulUid);
      }
      return bindFresh(store, k, key, explicitSoulUid);
    }

    // 2. native binding
    if (existing && existing.state === "bound") return existing;

    // 3-6. tool default -> account default -> unique -> refuse
    const soulUid = await pickSoul(root, snap, key);
    if (!soulUid || !snap.souls[soulUid]) return null;
    return bindFresh(store, k, key, soulUid);
  } finally {
    await store.close();
  }
}

/** Explicitly select (or switch) a Soul for a native session. */
export async function selectSoul(
  key: NativeSessionKey,
  soulUid: string,
  opts: LocalOptions = {},
): Promise<Binding | { error: "needs_new_session" }> {
  const root = resolveRoot(opts.root);
  assertNativeKey(key);
  const fs = { ...defaultStoreFs, ...(opts.fs ?? {}) };
  const store = await openStore(root, key.profile_id, { fs });
  try {
    const snap = await store.read();
    if (!snap.souls[soulUid]) {
      throw new StoreError("unknown_soul", `no local soul ${soulUid} in profile ${key.profile_id}`);
    }
    const k = bindingKey(key);
    const existing = snap.bindings[k];

    if (existing) {
      if (existing.state === "bound" && existing.soul_uid === soulUid) return toBinding(existing);
      // Switching an already-injected session loses the injected context: refuse.
      if (existing.state === "bound" && isInjected(snap, existing)) {
        return { error: "needs_new_session" };
      }
      return toBinding(await rebindExisting(store, snap, k, existing, soulUid));
    }

    return toBinding(await bindFresh(store, k, key, soulUid));
  } finally {
    await store.close();
  }
}

/** Detach a bound native session: same record, state detached, revision + 1. */
export async function detachBinding(key: NativeSessionKey, opts: LocalOptions = {}): Promise<Binding> {
  const root = resolveRoot(opts.root);
  assertNativeKey(key);
  const fs = { ...defaultStoreFs, ...(opts.fs ?? {}) };
  const store = await openStore(root, key.profile_id, { fs });
  try {
    const snap = await store.read();
    const k = bindingKey(key);
    const existing = snap.bindings[k];
    if (!existing || existing.state !== "bound") {
      throw new StoreError("not_bound", "no bound session to detach");
    }
    const pred = lastBindingOpId(snap, existing.session_ref);
    const next: BindingSnapshot = { ...existing, state: "detached", revision: existing.revision + 1 };
    const op = bindingOutboxOp(next, "detached", existing.revision, pred ? [pred] : []);
    await store.transact((draft) => {
      draft.bindings[k] = next;
      draft.outbox[op.operation_id] = op;
    });
    return toBinding(next);
  } finally {
    await store.close();
  }
}

// --- writer commands (registered at module top level) -------------------------------

/**
 * Task 4 calls this before committing extraction results frozen at `revision`.
 * Throws a typed StoreError when the binding no longer exists, is detached, or has
 * moved to a different revision (switch / detach / account switch) — a result frozen
 * at an old revision is recognizably stale and must be refused, never silently
 * applied over the current binding.
 */
export async function assertBindingCurrent(
  key: NativeSessionKey,
  bindingUid: string,
  revision: number,
  opts: LocalOptions = {},
): Promise<void> {
  const root = resolveRoot(opts.root);
  const fs = { ...defaultStoreFs, ...(opts.fs ?? {}) };
  const store = await openStore(root, key.profile_id, { fs });
  try {
    const snap = await store.read();
    const current = Object.values(snap.bindings).find((binding) => binding.binding_uid === bindingUid);
    if (!current) {
      throw new StoreError("unknown_binding", `no binding ${bindingUid} in profile ${key.profile_id}`);
    }
    if (current.state !== "bound" || current.revision !== revision) {
      throw new StoreError(
        "stale_binding",
        `binding ${bindingUid} is ${current.state} at revision ${current.revision}; a result frozen at revision ${revision} cannot be applied`,
      );
    }
  } finally {
    await store.close();
  }
}

function identityFromPayload(payload: Record<string, unknown>): Soul["identity"] {
  const identity = (payload.identity ?? {}) as Record<string, unknown>;
  const field = (key: string, fallback: string): string =>
    typeof identity[key] === "string" ? (identity[key] as string) : fallback;
  return {
    name: field("name", ""),
    description: field("description", ""),
    character: field("character", ""),
    greeting: field("greeting", ""),
  };
}

registerWriterCommand("create_soul", async ({ root, request }) => {
  const payload = request.payload;
  const soulUid = typeof payload.soul_uid === "string" && payload.soul_uid ? payload.soul_uid : randomUUID();
  const identity = identityFromPayload(payload);
  const soul: Soul = {
    soul_uid: soulUid,
    legacy_host_id: null,
    identity_revision: 1,
    identity,
    state: "active",
  };
  const op: OutboxOperation = {
    operation_id: randomUUID(),
    operation_kind: "register_soul",
    request: { soul_uid: soulUid, identity, consent_categories: [] },
    predecessor_operation_ids: [],
  };
  const store = await openStore(root, request.profile_id);
  try {
    await store.transact((draft) => {
      if (draft.souls[soulUid]) {
        throw new StoreError("already_exists", `soul ${soulUid} already exists in this profile`);
      }
      draft.souls[soulUid] = soul;
      draft.outbox[op.operation_id] = op;
    });
    return soul;
  } finally {
    await store.close();
  }
});

registerWriterCommand("edit_local_identity", async ({ root, request }) => {
  const soulUid = String(request.payload.soul_uid ?? "");
  const identity = identityFromPayload(request.payload);
  const store = await openStore(root, request.profile_id);
  try {
    const snap = await store.read();
    const soul = snap.souls[soulUid];
    if (!soul) throw new StoreError("unknown_soul", `no local soul ${soulUid}`);
    if (soul.legacy_host_id !== null) {
      // A registered Soul is a hosted identity: local edits would fork it.
      throw new StoreError("edit_on_website", `soul ${soulUid} is registered — edit its identity on 37soul.com`);
    }
    await store.transact((draft) => {
      const s = draft.souls[soulUid];
      s.identity = identity;
      s.identity_revision += 1;
    });
    return (await store.read()).souls[soulUid];
  } finally {
    await store.close();
  }
});

registerWriterCommand("bind", async ({ root, request }) => {
  const p = request.payload;
  const key: NativeSessionKey = {
    profile_id: request.profile_id,
    device_id: String(p.device_id ?? ""),
    runtime_kind: (p.runtime_kind ?? "claude-code") as RuntimeKind,
    native_session_id: String(p.native_session_id ?? ""),
  };
  return selectSoul(key, String(p.soul_uid ?? ""), { root });
});

registerWriterCommand("detach", async ({ root, request }) => {
  const p = request.payload;
  const key: NativeSessionKey = {
    profile_id: request.profile_id,
    device_id: String(p.device_id ?? ""),
    runtime_kind: (p.runtime_kind ?? "claude-code") as RuntimeKind,
    native_session_id: String(p.native_session_id ?? ""),
  };
  return detachBinding(key, { root });
});

registerWriterCommand("export", async ({ root, request }) => {
  // Local-only export of the owner-private core identity. Independent of any
  // subscription; never includes tokens or native session ids.
  const store = await openStore(root, request.profile_id);
  try {
    const snap = await store.read();
    return {
      protocol: "soul-assets/v1",
      profile_id: snap.profile_id,
      owner_id: snap.owner_id,
      souls: snap.souls,
      assets: snap.assets,
      consents: snap.consents,
    };
  } finally {
    await store.close();
  }
});

/**
 * §3 login association runs entirely inside one writer dispatch: owner association,
 * cloud_device_uid update, account default, and the §3 `mode` (as `soul_sync_mode`)
 * on the accounts index. The writer holds the lock across the whole handler, so the
 * CLI never commits the snapshot itself.
 *
 * `use_profile_id` (explicit `--use-profile`) switches the account index to an
 * existing same-owner profile WITHOUT merging: the current anonymous profile is left
 * untouched. `merge_profile_id` (explicit `--merge-profile`) merges that profile into
 * the current one via the resumable journal path, source kept, index switched last.
 */
registerWriterCommand("login_associate", async ({ root, request }) => {
  const p = request.payload;
  const ownerId = String(p.owner_id ?? "");
  const cloudDeviceUid = typeof p.cloud_device_uid === "string" ? p.cloud_device_uid : null;
  const defaultSoulUid = typeof p.default_soul_uid === "string" && p.default_soul_uid ? p.default_soul_uid : null;
  const mergeProfileId = typeof p.merge_profile_id === "string" && p.merge_profile_id ? p.merge_profile_id : undefined;
  const useProfileId = typeof p.use_profile_id === "string" && p.use_profile_id ? p.use_profile_id : undefined;
  const mode = typeof p.mode === "string" && p.mode ? p.mode : "assets_only";

  if (useProfileId) {
    // Switch, don't merge: the existing same-owner profile becomes the account's
    // profile; the current (anonymous) profile is never written.
    const existing = await openStore(root, useProfileId);
    const existingSnap = await existing.read();
    if (existingSnap.owner_id !== ownerId) {
      await existing.close();
      throw new StoreError("owner_mismatch", `profile ${useProfileId} does not belong to ${ownerId}`);
    }
    // A fresh login for a different cloud device must never clobber the adopted
    // profile's device binding.
    if (
      cloudDeviceUid !== null &&
      existingSnap.cloud_device_uid !== null &&
      existingSnap.cloud_device_uid !== cloudDeviceUid
    ) {
      await existing.close();
      throw new StoreError("device_mismatch", `profile ${useProfileId} is already bound to a different cloud device`);
    }
    // The writer holds the lock, so committing the login identity to the adopted
    // profile is legal; the CLI process never does this itself.
    await existing.transact((draft) => {
      draft.owner_id = ownerId;
      if (cloudDeviceUid !== null) draft.cloud_device_uid = cloudDeviceUid;
    });
    await existing.close();

    // Apply the server's default only when the Soul exists in the adopted profile;
    // otherwise leave resolution untouched (pickSoul reads defaults.json, not the index).
    let appliedDefault: string | null = null;
    if (defaultSoulUid && existingSnap.souls[defaultSoulUid]) {
      await setAccountDefaultSoul(useProfileId, defaultSoulUid, { root });
      appliedDefault = defaultSoulUid;
    }

    const index = await readAccountsIndex(root);
    index[ownerId] = {
      profile_id: useProfileId,
      default_soul_uid: appliedDefault ?? index[ownerId]?.default_soul_uid ?? null,
      soul_sync_mode: mode,
    };
    await writeAccountsIndex(root, index);
    return { profile_id: useProfileId, owner_id: ownerId, soul_sync_mode: mode };
  }

  const profileId = await mergeLoginProfile(request.profile_id, ownerId, mergeProfileId, { root });

  const store = await openStore(root, profileId);
  try {
    await store.transact((draft) => {
      draft.owner_id = ownerId;
      if (cloudDeviceUid !== null) draft.cloud_device_uid = cloudDeviceUid;
    });
  } finally {
    await store.close();
  }

  if (defaultSoulUid) await setAccountDefaultSoul(profileId, defaultSoulUid, { root });

  // Ruling 5: persist the §3 login `mode` so the host-id peek can gate on it.
  const index = await readAccountsIndex(root);
  index[ownerId] = {
    profile_id: profileId,
    default_soul_uid: defaultSoulUid ?? index[ownerId]?.default_soul_uid ?? null,
    soul_sync_mode: mode,
  };
  await writeAccountsIndex(root, index);

  return { profile_id: profileId, owner_id: ownerId, soul_sync_mode: mode };
});

/**
 * Anonymous-first install (assets_only default, zero HTTP, zero login): establish
 * the single anonymous assets profile and mark the account index `assets_only`.
 *
 * This mirrors `login_associate`'s ownership of the accounts index, but there is no
 * cloud identity: the profile's owner stays null and the index entry is keyed by the
 * sentinel owner key `"anonymous"` (never a real user id). The empty snapshot is
 * persisted through `transact` so `snapshot.json` carries the pinned `device_id` —
 * the field `resolveLocalAssetsProfileSync` requires before any assets-mode write
 * (hook emission, extraction watermarks) will be accepted.
 *
 * Idempotent: re-running keeps the already-pinned device id and the existing index
 * `default_soul_uid`, and only (re)asserts `soul_sync_mode: "assets_only"`.
 */
registerWriterCommand("init_assets_profile", async ({ root, request }) => {
  const profileId = typeof request.payload.profile_id === "string" && request.payload.profile_id
    ? request.payload.profile_id
    : request.profile_id;

  const store = await openStore(root, profileId);
  try {
    // Persist the empty snapshot (openStore already pins device_id in device.json;
    // this commit is what writes snapshot.json with that device_id).
    await store.transact(() => {});
  } finally {
    await store.close();
  }

  const ANONYMOUS_OWNER_KEY = "anonymous";
  const index = await readAccountsIndex(root);
  index[ANONYMOUS_OWNER_KEY] = {
    profile_id: profileId,
    default_soul_uid: index[ANONYMOUS_OWNER_KEY]?.default_soul_uid ?? null,
    soul_sync_mode: "assets_only",
  };
  await writeAccountsIndex(root, index);

  return { profile_id: profileId, owner_id: null, soul_sync_mode: "assets_only" };
});
