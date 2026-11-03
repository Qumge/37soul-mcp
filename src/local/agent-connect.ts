/** Local identity broker: scoped credentials never enter the agent's output. */
import type {RuntimeKind} from '../assets/protocol.js';
import {loadConfig} from '../agentd/state.js';
import {credentialForRuntime, selectCredentials} from '../agentd/credentials.js';
import {openStore, StoreError} from './store.js';
import {readAccountsIndex} from './profiles.js';
import {assertProfileCloudIssuer, requireCloudIssuer} from './profile-issuer.js';

export async function readLocalIdentity(root: string, profileId: string, hostId: number, runtime: RuntimeKind | undefined,
  deps: {apiBase: string; fetch: typeof fetch}): Promise<Record<string, unknown>> {
  const base = requireCloudIssuer(deps.apiBase);
  const currentAccess = async () => {
    const config = await loadConfig(root);
    const store = await openStore(root, profileId);
    try {
      const snap = await store.read();
      assertProfileCloudIssuer(snap, base, await readAccountsIndex(root));
      const credential = credentialForRuntime(selectCredentials(config, profileId, snap.owner_id, snap.cloud_device_uid, base), runtime);
      if (!credential) throw new StoreError('login_required', 'No credential for this account/server/runtime. Run 37soul login, then choose a Soul in your Agent.');
      const soul = Object.values(snap.souls).find(candidate => candidate.legacy_host_id === hostId);
      const consent = soul ? snap.consents[`${snap.cloud_device_uid}:${soul.soul_uid}`] : undefined;
      if (!soul || !consent) throw new StoreError("soul_not_selected", `This Soul is not connected yet. Use 37soul connect --host ${hostId} with the native session flags; your account login can be reused.`);
      if (!consent.enabled || !consent.categories.includes("identity")) throw new StoreError("identity_not_authorized", 'This Soul has revoked or disabled identity consent. Re-enable it explicitly; do not repeat account login as a role selection.');
      return {token: credential.token, owner: snap.owner_id, device: snap.cloud_device_uid, soul: soul.soul_uid, categories: [...consent.categories]};
    } finally { await store.close(); }
  };
  const initial = await currentAccess();
  let response: Response;
  let body: unknown;
  try {
    response = await deps.fetch(`${base}/api/v1/me/hosts/${hostId}/soul`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {Authorization: `Bearer ${initial.token}`, Accept: 'application/json'},
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new StoreError('login_required', 'Account credential expired or revoked. Run 37soul login.');
      if (response.status === 403) throw new StoreError('identity_not_authorized', 'This Soul has revoked or disabled consent. Re-enable it explicitly; do not change to remote OAuth.');
      throw new StoreError('identity_unavailable', `Could not read the selected Soul (HTTP ${response.status}).`);
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError('identity_unavailable', 'Could not read identity: network or timeout error. Retry this local command; do not start remote OAuth.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) ||
      typeof (body as Record<string, unknown>).you_are !== 'string' ||
      Number(((body as Record<string, unknown>).host as {id?: unknown} | undefined)?.id) !== hostId) {
    throw new StoreError('identity_mismatch', 'The server did not return the requested Soul. No session was changed.');
  }
  // The request can outlive a local revocation or account/device reassociation.
  // Re-read authority immediately before exposing any response to the agent.
  const current = await currentAccess();
  if (current.owner !== initial.owner || current.device !== initial.device || current.soul !== initial.soul) {
    throw new StoreError("active_profile_changed", "The account or device changed during identity lookup. Retry with current hook context.");
  }
  const categories = current.categories;
  const identity = body as Record<string, unknown>;
  // Also guard older servers until their authoritative endpoint is deployed:
  // callbacks and mood may embed relationship facts even without a facts field.
  if (!categories.includes("relationship")) {
    for (const field of ["relationship", "upcoming", "directive", "mood"]) delete identity[field];
  }
  if (!categories.includes("experience")) delete identity.recent_work;
  return identity;
}
