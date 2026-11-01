import { randomUUID } from "node:crypto";
import { sendWriter } from "./local/writer.js";

export interface RuntimeHealth { ok: boolean; agentd?: boolean; pid?: number; entrypoint?: string; detail?: string }

/** A real response proves a live process; a stale socket path proves nothing. */
export async function inspectRuntime(root: string): Promise<RuntimeHealth> {
  const reply = await sendWriter(root, { request_uid: randomUUID(), profile_id: "default", command: "health", payload: {} }, { timeoutMs: 500 });
  if (!reply.ok) return { ok: false, detail: reply.error.message };
  const result = reply.result as { writer_pid?: unknown; entrypoint?: unknown; agentd?: unknown } | null;
  if (!result || !Number.isInteger(result.writer_pid) || Number(result.writer_pid) < 1 || typeof result.entrypoint !== "string") return { ok: false, detail: "writer version unavailable — rerun install and restart agentd" };
  return { ok: true, pid: result.writer_pid as number, entrypoint: result.entrypoint, agentd: result.agentd === true };
}
