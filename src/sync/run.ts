/**
 * The single sync dispatch helper every trigger (CLI, login, daemon) shares.
 *
 * Sync is a writer command, never a lockless store write: `runSync` sends
 * `sync_once` through the exact dispatch pattern the extraction scheduler uses
 * (`sendWriter` → on `writer_unavailable`, `startWriter` → resend → close), so the
 * push/pull always serializes with every other store mutation. It never bypasses
 * the writer.
 *
 * The HTTP transport and its timeout bound live in the writer command handler
 * (`src/sync/client.ts`): the composition root injects the fetch via
 * `configureSyncHttp`, and the `sync_once` handler wraps it in a fresh
 * AbortController timeout per request, so a hung request cannot hold the writer
 * lock forever. No token, path, raw text or native session id enters the returned
 * shape: only `{ profile_id, report }`, where the report carries accepted/conflicts/
 * pending counts and, on failure, an error code.
 */
import { randomUUID } from "node:crypto";
import type { ProfileId } from "../adapters/types.js";
import { readAccountsIndex } from "../local/profiles.js";
import { sendWriter, startWriter, type WriterRequest, type WriterResult } from "../local/writer.js";
import type { SyncReport } from "./client.js";

function reportFromResult(result: WriterResult): SyncReport {
  if (result.ok) {
    const value = (result.result ?? {}) as Partial<SyncReport> | null;
    return {
      accepted: typeof value?.accepted === "number" ? value.accepted : 0,
      conflicts: typeof value?.conflicts === "number" ? value.conflicts : 0,
      pending: typeof value?.pending === "number" ? value.pending : 0,
      ...(typeof value?.error === "string" && value.error !== "" ? { error: value.error } : {}),
    };
  }
  return { accepted: 0, conflicts: 0, pending: 0, error: result.error.code };
}

/**
 * Run one profile's sync through the writer. Never throws: on a writer failure it
 * returns a zeroed report carrying the writer's error code. The transport must be
 * injected at the composition root with `configureSyncHttp` before dispatch.
 */
export async function runSync(root: string, profileId: ProfileId): Promise<SyncReport> {
  const request: WriterRequest = { request_uid: randomUUID(), profile_id: profileId, command: "sync_once", payload: {} };
  const direct = await sendWriter(root, request);
  if (direct.ok || direct.error.code !== "writer_unavailable") return reportFromResult(direct);

  const writer = await startWriter(root).catch(() => null);
  if (!writer) {
    // Lock held but not yet listening: resend once, then surface the refusal.
    return reportFromResult(await sendWriter(root, request));
  }
  try {
    return reportFromResult(await sendWriter(root, request));
  } finally {
    await writer.close().catch(() => {});
  }
}

export interface SyncProfileReport {
  profile_id: string;
  report: SyncReport;
}

/**
 * Resolve every local account entry in assets-only sync mode, then run each
 * profile's sync sequentially. Returns only profile ids and reports — never a
 * token, path, raw text or native session id.
 */
export async function runSyncProfiles(root: string): Promise<SyncProfileReport[]> {
  const index = await readAccountsIndex(root);
  const profileIds = [
    ...new Set(
      Object.values(index)
        .filter((entry) => entry.soul_sync_mode === "assets_only")
        .map((entry) => entry.profile_id),
    ),
  ];

  const out: SyncProfileReport[] = [];
  for (const profileId of profileIds) {
    out.push({ profile_id: profileId, report: await runSync(root, profileId) });
  }
  return out;
}
