/**
 * Task 3: account index and resumable anonymous-profile login merge.
 *
 * `<root>/accounts.json` (0600) maps owner_id -> { profile_id, default_soul_uid }.
 * Exactly two code paths write it: an anonymous->owner association and the
 * accounts-index switch at the end of a merge. It is always written last and
 * atomically (unique 0600 temp file -> `link` for the first write, `rename` for
 * a replace), so a torn write can never leave a half-visible index.
 *
 * `mergeLoginProfile(profileId, ownerId, mergeProfileId?)` is the login-time
 * entry point:
 *   - a profile already owned by a *different* owner is refused (owner_mismatch);
 *   - `mergeProfileId` (an optional source profile) is merged into the target by
 *     UID, conflicts kept (target wins on a UID collision, the source copy is
 *     never overwritten) and the source profile is left intact;
 *   - the target's owner_id is set, then the accounts index switches last.
 *
 * The merge itself is resumable: every step commits through its own
 * `store.transact` and is journaled in the target profile's 0600
 * `merge-journal.json` only *after* it lands, so a crash mid-merge resumes at the
 * first unjournaled step. Steps are idempotent (copy only keys the target lacks).
 *
 * Nothing here performs network I/O. `mergeLoginProfile` must keep working fully
 * offline — anonymous association and merge are local operations.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { link as fsLink, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultRoot } from "../agentd/state.js";
import type { ProfileId } from "../adapters/types.js";
import {
  defaultStoreFs,
  openStore,
  profileDir,
  profilesDir,
  snapshotPath,
  StoreError,
  type StoreFs,
  type StoreSnapshot,
} from "./store.js";

export interface AccountEntry {
  profile_id: ProfileId;
  default_soul_uid: string | null;
  /** §3 login `mode` response (currently "assets_only"); gates the host-id local peek. */
  soul_sync_mode: string | null;
}

export type AccountsIndex = Record<string, AccountEntry>;

export interface LocalOptions {
  root?: string;
  fs?: Partial<StoreFs>;
}

/** SOUL37_HOME names the *home* dir; the store root is home/.37soul (as in cli.ts). */
export function resolveRoot(root?: string): string {
  if (root) return root;
  return process.env.SOUL37_HOME ? path.join(process.env.SOUL37_HOME, ".37soul") : defaultRoot();
}

export function accountsIndexPath(root: string): string {
  return path.join(root, "accounts.json");
}

export function mergeJournalPath(root: string, profileId: ProfileId): string {
  return path.join(profileDir(root, profileId), "merge-journal.json");
}

export async function readAccountsIndex(root: string): Promise<AccountsIndex> {
  try {
    const raw = await readFile(accountsIndexPath(root), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AccountsIndex = {};
    for (const [ownerId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).profile_id === "string"
      ) {
        const e = entry as { profile_id: string; default_soul_uid?: unknown; soul_sync_mode?: unknown };
        out[ownerId] = {
          profile_id: e.profile_id,
          default_soul_uid: typeof e.default_soul_uid === "string" ? e.default_soul_uid : null,
          soul_sync_mode: typeof e.soul_sync_mode === "string" ? e.soul_sync_mode : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomic temp + `link` for the first write; `rename` for a replace. `link` is the
 * create-if-not-exists primitive (it fails with EEXIST instead of clobbering), which
 * keeps the very first association race-safe exactly like the device.json pin.
 */
export async function writeAccountsIndex(root: string, index: AccountsIndex): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = accountsIndexPath(root);
  const temp = path.join(root, `accounts.json.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  try {
    await fsLink(temp, target); // create-if-not-exists
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await rename(temp, target); // atomic replace of an existing index
  }
  await rm(temp, { force: true }).catch(() => {});
}

interface MergeJournal {
  owner_id: string;
  source_profile_id: ProfileId;
  completed: string[];
}

async function readMergeJournal(file: string, ownerId: string, sourceProfileId: ProfileId): Promise<MergeJournal> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<MergeJournal>;
    if (
      parsed.owner_id === ownerId &&
      parsed.source_profile_id === sourceProfileId &&
      Array.isArray(parsed.completed)
    ) {
      return { owner_id: ownerId, source_profile_id: sourceProfileId, completed: parsed.completed as string[] };
    }
  } catch {
    // A missing or torn journal is treated as a fresh merge; steps are idempotent.
  }
  return { owner_id: ownerId, source_profile_id: sourceProfileId, completed: [] };
}

async function writeMergeJournal(root: string, profileId: ProfileId, journal: MergeJournal): Promise<void> {
  await mkdir(profileDir(root, profileId), { recursive: true, mode: 0o700 });
  const target = mergeJournalPath(root, profileId);
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

interface MergeStep {
  id: string;
  apply: (target: StoreSnapshot, source: StoreSnapshot) => void;
}

const MERGE_STEPS: MergeStep[] = [
  {
    id: "souls",
    apply: (target, source) => {
      for (const [uid, soul] of Object.entries(source.souls)) {
        if (!target.souls[uid]) target.souls[uid] = soul; // same UID -> keep the target's copy
      }
    },
  },
  {
    id: "bindings",
    apply: (target, source) => {
      // Native bindings keep their original (profile, device) key so a session that
      // belonged to the source still resolves under the source's key — never re-keyed
      // onto the target's device, which would wrongly reassign another device's sessions.
      for (const [key, binding] of Object.entries(source.bindings)) {
        if (!target.bindings[key]) target.bindings[key] = binding;
      }
    },
  },
  {
    id: "assets",
    apply: (target, source) => {
      for (const [uid, asset] of Object.entries(source.assets)) if (!target.assets[uid]) target.assets[uid] = asset;
      for (const [uid, consent] of Object.entries(source.consents)) if (!target.consents[uid]) target.consents[uid] = consent;
      for (const [uid, tombstones] of Object.entries(source.digest_tombstones)) {
        if (!target.digest_tombstones[uid]) target.digest_tombstones[uid] = tombstones;
      }
      for (const [uid, watermark] of Object.entries(source.extraction_watermarks)) {
        if (!target.extraction_watermarks[uid]) target.extraction_watermarks[uid] = watermark;
      }
      for (const [uid, receipt] of Object.entries(source.receipts)) if (!target.receipts[uid]) target.receipts[uid] = receipt;
    },
  },
  {
    id: "queue",
    apply: (target, source) => {
      // Pending outbox and quarantined (conflicted) operations both survive, un-flattened.
      for (const [uid, op] of Object.entries(source.outbox)) if (!target.outbox[uid]) target.outbox[uid] = op;
      for (const [uid, op] of Object.entries(source.quarantine)) if (!target.quarantine[uid]) target.quarantine[uid] = op;
    },
  },
  {
    id: "cursor",
    apply: (target, source) => {
      if (target.pull_cursor === null) target.pull_cursor = source.pull_cursor;
    },
  },
];

/**
 * Merge `sourceProfileId` into `targetProfileId` by UID, resumably. The source
 * profile is only ever read, never written, so it stays intact on every path
 * (including a crash mid-merge).
 */
async function mergeProfiles(
  root: string,
  fs: StoreFs,
  targetProfileId: ProfileId,
  sourceProfileId: ProfileId,
  ownerId: string,
): Promise<void> {
  const journal = await readMergeJournal(mergeJournalPath(root, targetProfileId), ownerId, sourceProfileId);
  const completed = new Set(journal.completed);

  for (const step of MERGE_STEPS) {
    if (completed.has(step.id)) continue;
    const sourceStore = await openStore(root, sourceProfileId, { fs });
    const source = await sourceStore.read();
    await sourceStore.close();
    const targetStore = await openStore(root, targetProfileId, { fs });
    await targetStore.transact((draft) => step.apply(draft, source));
    await targetStore.close();
    journal.completed.push(step.id);
    await writeMergeJournal(root, targetProfileId, journal);
  }
  await rm(mergeJournalPath(root, targetProfileId), { force: true }).catch(() => {});
}

/**
 * Associate `profileId` with `ownerId`, optionally merging `mergeProfileId` in
 * first. Returns the target profile id. Fully local; never re-attaches a profile
 * that already belongs to a different owner.
 */
export async function mergeLoginProfile(
  profileId: ProfileId,
  ownerId: string,
  mergeProfileId?: ProfileId,
  opts: LocalOptions = {},
): Promise<ProfileId> {
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new StoreError("invalid_profile", "profile_id must be a non-empty string");
  }
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new StoreError("invalid_owner", "owner_id must be a non-empty string");
  }
  const root = resolveRoot(opts.root);
  const fs: StoreFs = { ...defaultStoreFs, ...(opts.fs ?? {}) };

  // A profile already owned by A must never be re-attached to B.
  const probe = await openStore(root, profileId, { fs });
  const current = await probe.read();
  await probe.close();
  if (current.owner_id !== null && current.owner_id !== ownerId) {
    throw new StoreError(
      "owner_mismatch",
      `profile ${profileId} already belongs to ${current.owner_id}; it cannot be re-attached to ${ownerId}`,
    );
  }

  if (mergeProfileId && mergeProfileId !== profileId) {
    await mergeProfiles(root, fs, profileId, mergeProfileId, ownerId);
  }

  // Association: set the owner on the target (its own transact).
  const store = await openStore(root, profileId, { fs });
  await store.transact((draft) => {
    draft.owner_id = ownerId;
  });
  await store.close();

  // The accounts-index switch is written last and atomically.
  const index = await readAccountsIndex(root);
  index[ownerId] = {
    profile_id: profileId,
    default_soul_uid: index[ownerId]?.default_soul_uid ?? null,
    soul_sync_mode: index[ownerId]?.soul_sync_mode ?? null,
  };
  await writeAccountsIndex(root, index);

  return profileId;
}

/**
 * Ruling 5 (assets-mode gate) for the MCP host-id peek. Synchronous and read-only:
 * returns a host id number only when the account index entry for the single local
 * profile is in assets mode (`soul_sync_mode === "assets_only"`) AND that profile's
 * store holds exactly one Soul with a legacy host id. Otherwise null, so the caller
 * keeps its env/default behavior. Never reads or exposes a native_session_id or path.
 */
export function resolveLocalHostIdSync(root: string): number | null {
  try {
    const entries = readdirSync(profilesDir(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (entries.length !== 1) return null; // only a single local profile can be consulted
    const profileId = entries[0];
    const accounts = JSON.parse(readFileSync(accountsIndexPath(root), "utf8")) as Record<
      string,
      { profile_id?: unknown; soul_sync_mode?: unknown }
    >;
    const entry = Object.values(accounts).find((e) => e.profile_id === profileId);
    if (!entry || entry.soul_sync_mode !== "assets_only") return null;
    const snapshot = JSON.parse(readFileSync(snapshotPath(root, profileId), "utf8")) as {
      souls?: Record<string, { legacy_host_id?: unknown }>;
    };
    const souls = Object.values(snapshot.souls ?? {});
    if (souls.length !== 1) return null;
    const hostId = souls[0].legacy_host_id;
    return typeof hostId === "number" && Number.isFinite(hostId) && hostId > 0 ? hostId : null;
  } catch {
    return null;
  }
}
