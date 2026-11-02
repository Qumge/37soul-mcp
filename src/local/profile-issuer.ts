/** Profile cloud data has its own issuer, independent of the mutable API config. */
import { normalizeServerIssuer, sameServerIssuer } from "../agentd/server-identity.js";
import { openStore, StoreError, type StoreSnapshot, type StoreFs } from "./store.js";

export function requireCloudIssuer(value: unknown): string {
  try { return normalizeServerIssuer(value as string); } catch {
    throw new StoreError("profile_issuer_unknown", "A valid cloud server issuer is required. Keep existing data and login with --profile <new-profile-id> for this server.");
  }
}

/** Missing issuer on already cloud-owned data is NOT an anonymous profile. */
export function assertProfileCloudIssuer(snapshot: StoreSnapshot, target: string): void {
  if (snapshot.owner_id === null && snapshot.cloud_device_uid === null && snapshot.cloud_issuer == null) return;
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
