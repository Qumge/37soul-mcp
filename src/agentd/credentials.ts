/**
 * Scoped cloud credentials.
 *
 * A token is only usable for the issuer/profile/owner/cloud-device/runtime it was issued
 * for. The legacy `config.tokens` map cannot prove any of that, so assets-mode sync
 * never falls back to it: an unbound token stays unused until the user logs in again.
 */
import { normalizeServerIssuer, sameServerIssuer } from "./server-identity.js";
import { loadConfig, saveConfig, type AgentConfig } from "./state.js";

export interface StoredCredential {
  issuer: string;
  token: string;
  owner_id: string;
  cloud_device_uid: string;
  runtime_kind: string;
  profile_id: string;
  obtained_at: string;
}

/** Parse consumable records without rewriting or promoting malformed stored data. */
function parseStoredCredential(raw: unknown): StoredCredential | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Partial<StoredCredential>;
  if (typeof entry.token !== "string" || !entry.token) return null;
  if (typeof entry.owner_id !== "string" || !entry.owner_id) return null;
  if (typeof entry.cloud_device_uid !== "string" || !entry.cloud_device_uid) return null;
  if (typeof entry.runtime_kind !== "string" || !entry.runtime_kind) return null;
  if (typeof entry.profile_id !== "string" || !entry.profile_id) return null;
  let issuer: string;
  try { issuer = normalizeServerIssuer(entry.issuer!); } catch { return null; }
  return {
    issuer,
    token: entry.token,
    owner_id: entry.owner_id,
    cloud_device_uid: entry.cloud_device_uid,
    runtime_kind: entry.runtime_kind,
    profile_id: entry.profile_id,
    obtained_at: typeof entry.obtained_at === "string" ? entry.obtained_at : "",
  };
}

export function readCredentials(config: AgentConfig | null | undefined): StoredCredential[] {
  if (!config || !Array.isArray(config.credentials)) return [];
  return config.credentials.flatMap(raw => {
    const credential = parseStoredCredential(raw);
    return credential ? [credential] : [];
  });
}

/** Tokens that are provably scoped to this profile + owner + cloud device. */
export function selectCredentials(
  config: AgentConfig | null | undefined,
  profileId: string,
  ownerId: string | null,
  cloudDeviceUid: string | null,
  targetBaseUrl: string | undefined = config?.api_base_url,
): StoredCredential[] {
  if (!ownerId || !cloudDeviceUid) return [];
  const byRuntime = new Map<string, StoredCredential>();
  for (const credential of readCredentials(config)) {
    if (!sameServerIssuer(credential.issuer, targetBaseUrl)) continue;
    if (credential.profile_id !== profileId) continue;
    if (credential.owner_id !== ownerId) continue;
    if (credential.cloud_device_uid !== cloudDeviceUid) continue;
    byRuntime.set(credential.runtime_kind, credential);
  }
  return [...byRuntime.values()];
}

export function credentialForRuntime(
  credentials: readonly StoredCredential[],
  runtimeKind: string | null | undefined,
): StoredCredential | null {
  if (!runtimeKind) return credentials[0] ?? null;
  return credentials.find((credential) => credential.runtime_kind === runtimeKind) ?? null;
}

export interface SaveLoginCredentialsInput {
  apiBaseUrl: string;
  machineId: string;
  profileId: string;
  ownerId: string;
  cloudDeviceUid: string;
  tokens: Record<string, string>;
}

/**
 * Persist the runtime tokens with their owner/device/profile scope. Existing
 * credentials for another owner or device are kept untouched; only the same
 * (issuer, profile, owner, device, runtime) slot is replaced.
 */
export async function saveLoginCredentials(root: string, input: SaveLoginCredentialsInput): Promise<void> {
  const issuer = normalizeServerIssuer(input.apiBaseUrl);
  const existing = await loadConfig(root);
  const config: AgentConfig = existing ?? {
    api_base_url: input.apiBaseUrl,
    machine_id: input.machineId,
    tokens: {},
  };
  // Keep unbound legacy records as data, never promote them to a usable credential.
  const kept = (config.credentials ?? []).filter(
    (raw) => {
      const credential = parseStoredCredential(raw);
      return credential === null || !(
        sameServerIssuer(credential.issuer, issuer) &&
        credential.profile_id === input.profileId &&
        credential.owner_id === input.ownerId &&
        credential.cloud_device_uid === input.cloudDeviceUid &&
        Object.prototype.hasOwnProperty.call(input.tokens, credential.runtime_kind)
      );
    },
  );
  const obtainedAt = new Date().toISOString();
  for (const [runtimeKind, token] of Object.entries(input.tokens)) {
    if (typeof token !== "string" || token.length === 0) continue;
    kept.push({
      issuer,
      token,
      owner_id: input.ownerId,
      cloud_device_uid: input.cloudDeviceUid,
      runtime_kind: runtimeKind,
      profile_id: input.profileId,
      obtained_at: obtainedAt,
    });
  }
  await saveConfig(root, {
    ...config,
    api_base_url: issuer,
    active_profile_id: input.profileId,
    credentials: kept,
    // Preserve the legacy map as data only. No sync authorization may use it;
    // only the issuer-bound credentials above are consumable.
    tokens: { ...(config.tokens ?? {}), ...input.tokens },
  });
}

/** Remove every credential for a revoked owner/device (called after device_revoked). */
export async function clearDeviceCredentials(
  root: string,
  ownerId: string | null,
  cloudDeviceUid: string | null,
  issuer?: string,
): Promise<void> {
  if (!ownerId || !cloudDeviceUid) return;
  const config = await loadConfig(root);
  if (!config) return;
  const kept = (config.credentials ?? []).filter(raw => {
    const credential = parseStoredCredential(raw);
    return credential === null || !(sameServerIssuer(credential.issuer, issuer ?? config.api_base_url) &&
      credential.owner_id === ownerId && credential.cloud_device_uid === cloudDeviceUid);
  });
  await saveConfig(root, { ...config, credentials: kept });
}
