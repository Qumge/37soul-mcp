/** Read-only local observations, never a claim of host trust or model adoption. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeKind } from "../assets/protocol.js";
import { resolveLocalAssetsProfileSync } from "../local/profiles.js";
import { snapshotPath } from "../local/store.js";
import type { HostDoctorCheck } from "./types.js";

export interface RuntimeEvidence {
  profile_id: string | null;
  hook_output_observed: boolean;
  extraction_completed: boolean;
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** No openStore: diagnostics must not pin devices, recover files or create data. */
export async function readRuntimeEvidence(home: string, runtimeKind: RuntimeKind): Promise<RuntimeEvidence> {
  const none: RuntimeEvidence = { profile_id: null, hook_output_observed: false, extraction_completed: false };
  const root = path.join(home, ".37soul");
  const active = resolveLocalAssetsProfileSync(root);
  if (!active) return none;
  try {
    const snapshot: unknown = JSON.parse(await readFile(snapshotPath(root, active.profile_id), "utf8"));
    if (!record(snapshot) || snapshot.profile_id !== active.profile_id || snapshot.device_id !== active.device_id ||
        !record(snapshot.bindings) || !record(snapshot.receipts) || !record(snapshot.extraction_watermarks)) return none;
    // Recheck selection after the asynchronous read; a switch must not lend a
    // previous profile's observations to the newly selected profile.
    const current = resolveLocalAssetsProfileSync(root);
    if (current?.profile_id !== active.profile_id || current.device_id !== active.device_id) return none;
    const bindings = Object.entries(snapshot.bindings).flatMap(([key, binding]) => {
      if (!record(binding) || binding.profile_id !== active.profile_id || binding.device_id !== active.device_id ||
          binding.runtime_kind !== runtimeKind || binding.state !== "bound" ||
          typeof binding.binding_uid !== "string" || !binding.binding_uid ||
          typeof binding.native_session_id !== "string" || !binding.native_session_id ||
          !Number.isInteger(binding.revision) || binding.revision < 1 ||
          key !== [active.profile_id, active.device_id, runtimeKind, binding.native_session_id].join("\0")) return [];
      return [binding];
    });
    const hookOutput = Object.values(snapshot.receipts).some(receipt => record(receipt) &&
      receipt.stage === "injected" && typeof receipt.rendered_sha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.rendered_sha256) &&
      Array.isArray(receipt.manifest) && bindings.some(binding => binding.binding_uid === receipt.binding_uid && binding.revision === receipt.binding_revision));
    const extracted = Object.values(snapshot.extraction_watermarks).some(watermark => {
      if (!record(watermark) || watermark.completed !== true || watermark.state !== "completed" || watermark.last_error !== null || !record(watermark.request)) return false;
      const request = watermark.request;
      return request.runtime_kind === runtimeKind && request.internal_task === true &&
        typeof request.job_uid === "string" && request.job_uid.length > 0 &&
        Array.isArray(request.source_event_refs) && request.source_event_refs.length > 0 &&
        request.source_event_refs.every((ref: unknown) => typeof ref === "string" && ref.length > 0) &&
        bindings.some(binding => binding.binding_uid === request.binding_uid && binding.revision === request.binding_revision &&
          binding.native_session_id === request.native_session_id && binding.soul_uid === request.soul_uid);
    });
    return { profile_id: active.profile_id, hook_output_observed: hookOutput, extraction_completed: extracted };
  } catch { return none; }
}

/** Shared wording preserves the boundary between bridge output and model use. */
export function runtimeEvidenceChecks(runtimeKind: RuntimeKind, evidence: RuntimeEvidence): Array<HostDoctorCheck & { waiting?: boolean }> {
  return [
    { name: `${runtimeKind}: hook output`, ok: evidence.hook_output_observed, waiting: !evidence.hook_output_observed,
      detail: evidence.hook_output_observed ? "Context output to hook/bridge observed for the active profile and device; not proof of model adoption." : "No matching hook/bridge context-output receipt observed for the active profile and device." },
    { name: `${runtimeKind}: extraction`, ok: evidence.extraction_completed, waiting: !evidence.extraction_completed,
      detail: evidence.extraction_completed ? "Completed extraction observed for the active profile, device and runtime; not proof of model adoption or background service execution." : "No matching completed extraction observed for the active profile, device and runtime." },
  ];
}
