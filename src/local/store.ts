/**
 * Task 2: single-writer transactional local soul store.
 *
 * One snapshot file per profile at ~/.37soul/profiles/<profile_id>/snapshot.json,
 * plus the previous valid snapshot at snapshot.json.bak. A commit is atomic:
 * 0600 temp file -> fsync file -> back up the current valid snapshot -> rename ->
 * fsync the directory. A corrupt main snapshot is recovered from .bak; when both
 * are corrupt the store stops writing, keeps the files untouched and reports a
 * repair_required state — it never replaces them with an empty store.
 *
 * The store lives beside the legacy state.json/config.json/spool/queue and never
 * reuses them for assets. The only legacy migration is the machine id (device_id)
 * from state.json; a corrupt state.json can never clear the new assets.
 *
 * The whole commit goes through the injectable `StoreFs` seam (openStore's third
 * argument). Tests inject crashes / errno failures at exact points, so the atomic
 * rename-based commit is exercised for real, not by a mock that never fires.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import path from "node:path";
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
  const deviceId = options.deviceId ?? (await readMachineId(root)) ?? randomUUID();

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

  const mainRaw = await readIfPresent(fs, main);
  if (mainRaw !== null) {
    const parsed = parseValid(mainRaw, profileId);
    if (parsed) return { kind: "ok", snapshot: parsed, recovered: false };
    const bakRaw = await readIfPresent(fs, bak);
    if (bakRaw !== null) {
      const bakParsed = parseValid(bakRaw, profileId);
      if (bakParsed) return { kind: "ok", snapshot: bakParsed, recovered: true };
    }
    return {
      kind: "repair",
      message: `snapshot for profile ${profileId} is corrupt and no valid backup exists; refusing to overwrite it with an empty store (repair required)`,
    };
  }

  const bakRaw = await readIfPresent(fs, bak);
  if (bakRaw !== null) {
    const bakParsed = parseValid(bakRaw, profileId);
    if (bakParsed) return { kind: "ok", snapshot: bakParsed, recovered: true };
    return {
      kind: "repair",
      message: `snapshot for profile ${profileId} is missing and its backup is corrupt; refusing to overwrite it with an empty store (repair required)`,
    };
  }

  return { kind: "fresh" };
}

async function readIfPresent(fs: StoreFs, file: string): Promise<string | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
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
  const raw = await readIfPresent(fs, target);
  if (raw === null) return false;
  return parseValid(raw, profileId) !== null;
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
 * Exclusive-create lock with live-holder verification and atomic stale takeover.
 * Only one caller can win the takeover rename, so a lost-lock race can never start
 * a second writer: the losers hit ENOENT, retry, see the winner's live lock and are
 * refused with `locked`.
 */
export async function acquireWriterLock(
  root: string,
  fs: StoreFs = defaultStoreFs,
): Promise<() => Promise<void>> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const file = writerLockPath(root);
  const payload = JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    token: randomUUID(),
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        await fs.rm(file, { force: true }).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = await readLockHolder(fs, file);
      if (holder !== null && isProcessAlive(holder.pid)) {
        throw new WriterLockBusyError(`another writer is already running (pid ${holder.pid})`);
      }
      const token = `${file}.stale-${process.pid}-${randomUUID()}`;
      try {
        await fs.rename(file, token);
        await fs.rm(token, { force: true }).catch(() => {});
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
    }
  }
  throw new WriterLockBusyError("could not acquire the writer lock");
}

async function readLockHolder(fs: StoreFs, file: string): Promise<{ pid: number } | null> {
  const raw = await readIfPresent(fs, file);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : null;
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
