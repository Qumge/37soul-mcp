/**
 * Task 2: single-writer transactional local soul store.
 *
 * One snapshot file per profile at ~/.37soul/profiles/<profile_id>/snapshot.json,
 * plus the previous valid snapshot at snapshot.json.bak. A commit is atomic:
 * 0600 temp file -> fsync file -> back up the current valid snapshot -> rename ->
 * fsync the directory. A corrupt main snapshot is recovered from .bak; when both
 * are corrupt the store stops writing, keeps the files untouched and reports a
 * repair_required state — it never replaces them with an empty store. An unreadable
 * snapshot is likewise never conflated with a fresh store (only ENOENT means absent).
 *
 * The store lives beside the legacy state.json/config.json/spool/queue and never
 * reuses them for assets. The only legacy migration is the machine id (device_id)
 * from a valid state.json; a corrupt state.json can never clear the new assets. A
 * per-profile device.json (0600) pins the generated device_id immutably so a fresh
 * anonymous profile keeps one stable id from the very first open.
 *
 * The whole commit goes through the injectable `StoreFs` seam (openStore's third
 * argument). Tests inject crashes / errno failures at exact points, so the atomic
 * rename-based commit is exercised for real, not by a mock that never fires.
 */
import { randomUUID } from "node:crypto";
import {
  link as fsLink,
  mkdir,
  open,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Asset, AssetTombstone, Consent, Soul } from "../assets/protocol.js";
import type { BindingSnapshot, ExtractionRequest, ProfileId } from "../adapters/types.js";
import { readMachineId } from "../agentd/state.js";

export type { ProfileId } from "../adapters/types.js";

export type SyncState = "local_only" | "pending_sync" | "synced" | "conflict";

/** Asset plus local sync bookkeeping (§2.5 / plan 内部类型边界). */
export type LocalAsset = Asset & {
  sync_state: SyncState;
  cloud_revision: number | null;
};

export type OutboxOperationKind = "register_soul" | "consent" | "binding" | "asset";

/** Immutable, topologically ordered outbox item (operation_id is the Idempotency-Key). */
export interface OutboxOperation {
  operation_id: string;
  operation_kind: OutboxOperationKind;
  request: Record<string, unknown>;
  predecessor_operation_ids: string[];
}

/** A rejected/conflicted operation parked out of the send queue, with its reason. */
export interface QuarantinedOperation {
  operation: OutboxOperation;
  reason: string;
}

export type ExtractionWatermarkState = "pending" | "running" | "completed" | "error";

export interface ExtractionWatermark {
  completed: boolean;
  attempts: number;
  state: ExtractionWatermarkState;
  last_error: string | null;
  /** The frozen extraction request this watermark belongs to. */
  request: ExtractionRequest;
}

export interface Receipt {
  binding_uid: string;
  binding_revision: number;
  stage: "downloaded" | "injected";
  manifest: { asset_uid: string; revision: number }[];
  rendered_sha256: string;
}

/** The fixed §2.5 snapshot fields. Record keys: souls/bindings/assets by UID,
 * consents by device+Soul, outbox/quarantine by operation_id, receipts by UUID. */
export interface StoreSnapshot {
  store_version: 1;
  profile_id: ProfileId;
  owner_id: string | null;
  device_id: string;
  cloud_device_uid: string | null;
  souls: Record<string, Soul>;
  bindings: Record<string, BindingSnapshot>;
  assets: Record<string, LocalAsset>;
  consents: Record<string, Consent>;
  digest_tombstones: Record<string, AssetTombstone[]>;
  outbox: Record<string, OutboxOperation>;
  quarantine: Record<string, QuarantinedOperation>;
  pull_cursor: string | null;
  extraction_watermarks: Record<string, ExtractionWatermark>;
  receipts: Record<string, Receipt>;
}

export interface LocalStore {
  read(): Promise<StoreSnapshot>;
  transact(change: (draft: StoreSnapshot) => void): Promise<StoreSnapshot>;
  close(): Promise<void>;
}

export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export class WriterLockBusyError extends StoreError {
  constructor(message: string) {
    super("locked", message);
  }
}

export interface FsFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Injectable fs seam. The default is a thin wrapper over node:fs/promises. */
export interface StoreFs {
  mkdir(dir: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  writeFile(file: string, data: string, options?: { mode?: number }): Promise<void>;
  readFile(file: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  /** Atomic create-if-not-exists (fails with EEXIST instead of overwriting). */
  link(from: string, to: string): Promise<void>;
  rm(file: string, options?: { force?: boolean }): Promise<void>;
  open(file: string, flags: string, mode?: number): Promise<FsFileHandle>;
  fsyncFile(file: string): Promise<void>;
  fsyncDir(dir: string): Promise<void>;
}

export const defaultStoreFs: StoreFs = {
  mkdir: async (dir, options) => {
    await mkdir(dir, options);
  },
  writeFile: (file, data, options) => fsWriteFile(file, data, options),
  readFile: (file) => fsReadFile(file, "utf8"),
  rename: (from, to) => fsRename(from, to),
  link: (from, to) => fsLink(from, to),
  rm: (file, options) => fsRm(file, options),
  open: async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    return {
      writeFile: (data) => handle.writeFile(data),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  fsyncFile: async (file) => {
    try {
      const handle = await open(file, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Best-effort: durability only; read-consistency comes from the rename.
    }
  },
  fsyncDir: async (dir) => {
    try {
      const handle = await open(dir, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Best-effort: some platforms refuse to fsync directories.
    }
  },
};

export function profilesDir(root: string): string {
  return path.join(root, "profiles");
}

export function profileDir(root: string, profileId: ProfileId): string {
  return path.join(profilesDir(root), profileId);
}

export function snapshotPath(root: string, profileId: ProfileId): string {
  return path.join(profileDir(root, profileId), "snapshot.json");
}

export function snapshotBackupPath(root: string, profileId: ProfileId): string {
  return path.join(profileDir(root, profileId), "snapshot.json.bak");
}

export function devicePath(root: string, profileId: ProfileId): string {
  return path.join(profileDir(root, profileId), "device.json");
}

export function writerLockPath(root: string): string {
  return path.join(root, "writer.lock");
}

export function ipcDir(root: string): string {
  return path.join(root, "ipc");
}

export function ipcSocketPath(root: string): string {
  return path.join(ipcDir(root), "writer.sock");
}

export function emptySnapshot(profileId: ProfileId, deviceId: string): StoreSnapshot {
  return {
    store_version: 1,
    profile_id: profileId,
    owner_id: null,
    device_id: deviceId,
    cloud_device_uid: null,
    souls: {},
    bindings: {},
    assets: {},
    consents: {},
    digest_tombstones: {},
    outbox: {},
    quarantine: {},
    pull_cursor: null,
    extraction_watermarks: {},
    receipts: {},
  };
}

export interface OpenStoreOptions {
  fs?: Partial<StoreFs>;
  deviceId?: string;
}

export async function openStore(
  root: string,
  profileId: ProfileId,
  options: OpenStoreOptions = {},
): Promise<LocalStore> {
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new StoreError("invalid_profile", "profile_id must be a non-empty string");
  }
  const fs: StoreFs = { ...defaultStoreFs, ...(options.fs ?? {}) };
  const deviceId = options.deviceId ?? (await resolveDeviceId(fs, root, profileId));

  let closed = false;
  let mutex: Promise<void> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = mutex.then(fn, fn);
    mutex = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const ensureOpen = (): void => {
    if (closed) throw new StoreError("closed", "store is closed");
  };

  async function currentSnapshot(): Promise<StoreSnapshot> {
    const loaded = await loadSnapshot(fs, root, profileId);
    if (loaded.kind === "repair") throw new StoreError("repair_required", loaded.message);
    if (loaded.kind === "fresh") return emptySnapshot(profileId, deviceId);
    return loaded.snapshot;
  }

  return {
    async read(): Promise<StoreSnapshot> {
      ensureOpen();
      return structuredClone(await currentSnapshot());
    },

    async transact(change: (draft: StoreSnapshot) => void): Promise<StoreSnapshot> {
      ensureOpen();
      return serialize(async () => {
        const current = await currentSnapshot();
        const draft = structuredClone(current);
        change(draft); // a throwing change aborts: nothing is persisted
        if (!isStoreSnapshot(draft)) {
          throw new StoreError("invalid_snapshot", "change produced an invalid snapshot; nothing was written");
        }
        const serialized = `${JSON.stringify(draft, null, 2)}\n`;
        await commit(fs, root, profileId, serialized);
        return structuredClone(draft);
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await mutex; // wait for any in-flight commit
    },
  };
}

/**
 * The per-profile device id, stable from the very first open (Task 3 keys bindings
 * on profile_id + device_id). Precedence: an already-persisted device.json (immutable
 * once created) -> legacy state.json machine id -> a freshly generated UUID, which is
 * persisted to device.json atomically so repeated opens agree even without a login.
 * `options.deviceId` (the test seam) bypasses all of this and is never persisted.
 */
async function resolveDeviceId(fs: StoreFs, root: string, profileId: ProfileId): Promise<string> {
  const file = devicePath(root, profileId);
  const persisted = await readDeviceId(fs, file);
  if (persisted !== null) return persisted;

  const machine = await readMachineId(root);
  const candidate = machine ?? randomUUID();
  await persistDeviceId(fs, root, profileId, candidate);
  // A concurrent first-open may have won; read back so every caller agrees.
  return (await readDeviceId(fs, file)) ?? candidate;
}

async function readDeviceId(fs: StoreFs, file: string): Promise<string | null> {
  const read = await readSnapshotFile(fs, file);
  if (read.kind !== "ok") return null;
  try {
    const parsed = JSON.parse(read.raw) as { device_id?: unknown };
    return typeof parsed.device_id === "string" && parsed.device_id !== "" ? parsed.device_id : null;
  } catch {
    return null;
  }
}

async function persistDeviceId(
  fs: StoreFs,
  root: string,
  profileId: ProfileId,
  id: string,
): Promise<void> {
  const dir = profileDir(root, profileId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = devicePath(root, profileId);
  const temp = path.join(dir, `device.json.tmp-${process.pid}-${randomUUID()}`);
  const handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ device_id: id })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temp, file); // create-if-not-exists: never clobber a concurrent winner
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw mapWriteError(error);
    return; // a concurrent first-open already persisted it; keep theirs
  }
  await fs.rm(temp, { force: true }).catch(() => {});
  await fs.fsyncDir(dir);
}

type LoadedSnapshot =
  | { kind: "ok"; snapshot: StoreSnapshot; recovered: boolean }
  | { kind: "fresh" }
  | { kind: "repair"; message: string };

async function loadSnapshot(
  fs: StoreFs,
  root: string,
  profileId: ProfileId,
): Promise<LoadedSnapshot> {
  const main = snapshotPath(root, profileId);
  const bak = snapshotBackupPath(root, profileId);

  const mainRead = await readSnapshotFile(fs, main);
  if (mainRead.kind === "unreadable") {
    return {
      kind: "repair",
      message: `snapshot for profile ${profileId} is unreadable (${mainRead.code}); refusing to overwrite it with an empty store (repair required)`,
    };
  }
  if (mainRead.kind === "ok") {
    const parsed = parseValid(mainRead.raw, profileId);
    if (parsed) return { kind: "ok", snapshot: parsed, recovered: false };
    const bakRead = await readSnapshotFile(fs, bak);
    if (bakRead.kind === "unreadable") {
      return {
        kind: "repair",
        message: `snapshot for profile ${profileId} is corrupt and its backup is unreadable (${bakRead.code}); refusing to overwrite with an empty store (repair required)`,
      };
    }
    if (bakRead.kind === "ok") {
      const bakParsed = parseValid(bakRead.raw, profileId);
      if (bakParsed) return { kind: "ok", snapshot: bakParsed, recovered: true };
    }
    return {
      kind: "repair",
      message: `snapshot for profile ${profileId} is corrupt and no valid backup exists; refusing to overwrite it with an empty store (repair required)`,
    };
  }

  // Main is missing.
  const bakRead = await readSnapshotFile(fs, bak);
  if (bakRead.kind === "unreadable") {
    return {
      kind: "repair",
      message: `snapshot for profile ${profileId} is missing and its backup is unreadable (${bakRead.code}); refusing to overwrite with an empty store (repair required)`,
    };
  }
  if (bakRead.kind === "ok") {
    const bakParsed = parseValid(bakRead.raw, profileId);
    if (bakParsed) return { kind: "ok", snapshot: bakParsed, recovered: true };
    return {
      kind: "repair",
      message: `snapshot for profile ${profileId} is missing and its backup is corrupt; refusing to overwrite with an empty store (repair required)`,
    };
  }

  return { kind: "fresh" };
}

type ReadSnapshotResult =
  | { kind: "ok"; raw: string }
  | { kind: "missing" }
  | { kind: "unreadable"; code: string; message: string };

/**
 * Only ENOENT means "absent". Any other read error on an existing path means
 * "present but unreadable" and must never be conflated with a fresh store —
 * otherwise an unreadable snapshot would be silently overwritten with an empty one.
 */
async function readSnapshotFile(fs: StoreFs, file: string): Promise<ReadSnapshotResult> {
  try {
    const raw = await fs.readFile(file);
    return { kind: "ok", raw };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { kind: "missing" };
    return {
      kind: "unreadable",
      code: code ?? "EIO",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseValid(raw: string, profileId: ProfileId): StoreSnapshot | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (isStoreSnapshot(value) && value.profile_id === profileId) return value;
    return null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStoreSnapshot(value: unknown): value is StoreSnapshot {
  if (!isRecord(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    s.store_version === 1 &&
    typeof s.profile_id === "string" &&
    s.profile_id.length > 0 &&
    typeof s.device_id === "string" &&
    s.device_id.length > 0 &&
    (s.owner_id === null || typeof s.owner_id === "string") &&
    (s.cloud_device_uid === null || typeof s.cloud_device_uid === "string") &&
    isRecord(s.souls) &&
    isRecord(s.bindings) &&
    isRecord(s.assets) &&
    isRecord(s.consents) &&
    isRecord(s.digest_tombstones) &&
    isRecord(s.outbox) &&
    isRecord(s.quarantine) &&
    (s.pull_cursor === null || typeof s.pull_cursor === "string") &&
    isRecord(s.extraction_watermarks) &&
    isRecord(s.receipts)
  );
}

async function commit(
  fs: StoreFs,
  root: string,
  profileId: ProfileId,
  serialized: string,
): Promise<void> {
  const dir = profileDir(root, profileId);
  const target = snapshotPath(root, profileId);
  const bak = snapshotBackupPath(root, profileId);
  const temp = path.join(dir, `snapshot.json.tmp-${process.pid}-${randomUUID()}`);

  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // 1. 0600 temp file
    await fs.writeFile(temp, serialized, { mode: 0o600 });
    // 2. fsync the file so its bytes are on disk before it becomes visible
    await fs.fsyncFile(temp);
    // 3. back up the current valid snapshot; never move a corrupt main over a good .bak
    if (await isCurrentValid(fs, target, profileId)) {
      await fs.rename(target, bak);
    }
    // 4. atomically replace
    await fs.rename(temp, target);
    // 5. fsync the directory so the rename is durable
    await fs.fsyncDir(dir);
  } catch (error) {
    throw mapWriteError(error);
  }
}

async function isCurrentValid(fs: StoreFs, target: string, profileId: ProfileId): Promise<boolean> {
  const read = await readSnapshotFile(fs, target);
  if (read.kind === "ok") return parseValid(read.raw, profileId) !== null;
  if (read.kind === "unreadable") {
    // Present but unreadable now (e.g. a permission change mid-transaction): stop,
    // never rename an empty draft over it.
    throw new StoreError(
      "repair_required",
      `snapshot at ${target} is unreadable (${read.code}); refusing to overwrite it`,
    );
  }
  return false;
}

function mapWriteError(error: unknown): StoreError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC") {
    return new StoreError(
      "capacity",
      "snapshot not written (disk full, ENOSPC); the existing snapshot and all assets/tombstones/outbox are unchanged — free space or export assets, then retry",
    );
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new StoreError(
      "permission",
      `snapshot not written (${code}); the existing snapshot is unchanged — check the profile directory permissions`,
    );
  }
  if (error instanceof StoreError) return error;
  return new StoreError(
    "io",
    `snapshot not written; the existing snapshot is unchanged (${(error as Error)?.message ?? String(error)})`,
  );
}

// --- single-writer process lock --------------------------------------------------

/**
 * Exclusive single-writer lock.
 *
 * The payload is written to a unique temp file first and then `link`ed into place:
 * link() fails with EEXIST instead of overwriting, so the lock file is never
 * observable empty or partial — a concurrent EEXIST reader cannot steal a live
 * writer's lock mid-create. An empty/unparseable lock is treated as "possibly live"
 * and given a bounded grace before a stale takeover, and release verifies the token
 * still matches before deleting, so a writer can never delete a lock it no longer owns.
 */
export async function acquireWriterLock(
  root: string,
  fs: StoreFs = defaultStoreFs,
): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = writerLockPath(root);
  const token = randomUUID();
  const payload = JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    token,
  });

  let grace = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const temp = `${file}.create-${process.pid}-${randomUUID()}`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temp, file);
      await fs.rm(temp, { force: true }).catch(() => {});
      return async () => {
        // Release only if we still own it: never delete a lock a competitor replaced.
        const holder = await readLockHolder(fs, file);
        if (holder !== null && holder.token === token && holder.pid === process.pid) {
          await fs.rm(file, { force: true }).catch(() => {});
        }
      };
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const holder = await readLockHolder(fs, file);
    if (holder !== null && isProcessAlive(holder.pid)) {
      throw new WriterLockBusyError(`another writer is already running (pid ${holder.pid})`);
    }
    // Empty/unparseable lock: possibly live (old-format writer mid-create). Give it a
    // bounded grace before stealing instead of ripping it away immediately.
    if (holder === null && grace < 7) {
      grace += 1;
      await sleep(50 * grace);
      continue;
    }
    // Dead holder, or an unparseable lock past the grace: atomic stale takeover.
    // Only one caller wins the rename; losers hit ENOENT and retry. Always `continue`
    // afterwards so the very next iteration links into the now-vacant path and
    // acquires — the writer must not clean up a stale lock and then fail to start.
    const stale = `${file}.stale-${process.pid}-${randomUUID()}`;
    try {
      await fs.rename(file, stale);
      await fs.rm(stale, { force: true }).catch(() => {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    continue;
  }
  throw new WriterLockBusyError("could not acquire the writer lock");
}

async function readLockHolder(fs: StoreFs, file: string): Promise<{ pid: number; token?: string } | null> {
  const read = await readSnapshotFile(fs, file);
  if (read.kind !== "ok") return null;
  try {
    const parsed = JSON.parse(read.raw) as { pid?: unknown; token?: unknown };
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, ...(typeof parsed.token === "string" ? { token: parsed.token } : {}) };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
