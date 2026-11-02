/** Profile cloud data has its own issuer, independent of the mutable API config. */
import { normalizeServerIssuer, sameServerIssuer } from "../agentd/server-identity.js";
import type { AccountsIndex } from "./profiles.js";
import { openStore, StoreError, type StoreSnapshot, type StoreFs } from "./store.js";

export function requireCloudIssuer(value: unknown): string {
  try { return normalizeServerIssuer(value as string); } catch {
    throw new StoreError("profile_issuer_unknown", "A valid cloud server issuer is required. Keep existing data and login with --profile <new-profile-id> for this server.");
  }
}

/** Missing issuer on already cloud-owned data is NOT an anonymous profile. */
export function assertProfileCloudIssuer(snapshot: StoreSnapshot, target: string, index: AccountsIndex = {}): void {
  const hasCloudSoul = Object.values(snapshot.souls).some(soul => soul.origin === "cloud" ||
    (typeof soul.legacy_host_id === "number" && Number.isFinite(soul.legacy_host_id) && soul.legacy_host_id > 0));
  const hasCloudAsset = Object.values(snapshot.assets).some(asset => asset.sync_state === "synced" ||
    (typeof asset.cloud_revision === "number" && asset.cloud_revision > 0));
  const pureLocal = snapshot.owner_id === null && snapshot.cloud_device_uid === null && snapshot.cloud_issuer == null &&
      !hasCloudSoul && !hasCloudAsset && snapshot.pull_cursor === null;
  const associated = Object.entries(index).filter(([, entry]) => entry.profile_id === snapshot.profile_id);
  for (const [owner, entry] of associated) {
    if (owner === "anonymous" && pureLocal && entry.cloud_issuer == null) continue;
    if (owner !== snapshot.owner_id || !sameServerIssuer(entry.cloud_issuer, target)) {
      throw new StoreError("profile_issuer_mismatch", `Profile ${snapshot.profile_id} has a different or unknown account server association. Existing data was not changed. Use login --profile <new-profile-id> for this server.`);
    }
  }
  if (pureLocal) return;
  if (!sameServerIssuer(snapshot.cloud_issuer, target)) {
    throw new StoreError("profile_issuer_mismatch", `Profile ${snapshot.profile_id} has a different or unknown cloud server issuer. Existing data was not changed. Use login --profile <new-profile-id> for this server; cross-server --merge-profile/--use-profile is not allowed.`);
  }
}

/** Use in CLI before login and again under the writer lock before mutation. */
export async function assertLoginProfileIssuers(
  root: string,
  profileIds: readonly string[],
  issuer: string,
  fs?: Partial<StoreFs>,
): Promise<void> {
  for (const id of new Set(profileIds)) {
    const store = await openStore(root, id, { fs });
    try { assertProfileCloudIssuer(await store.read(), issuer); } finally { await store.close(); }
  }
}
