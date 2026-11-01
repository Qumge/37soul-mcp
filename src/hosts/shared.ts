/** Host-independent helpers; no imports from the orchestration entry points. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { extractTranscriptPath } from "../agentd/source-index.js";
import type { HostDoctorCheck, HostHookPayload } from "./types.js";

/** All current bridges normalize their native fields to this existing hook shape. */
export function parseHookPayload(payload: Record<string, any>): HostHookPayload {
  // Read session_id first to preserve the legacy null-payload error receipt.
  const sessionId = String(payload.session_id ?? payload.sessionId ?? payload.thread_id ?? "unknown");
  const prompt = [payload.prompt, payload.user_prompt, payload.userPrompt, payload.message, payload.text]
    .find((value) => typeof value === "string" && value.trim() !== "");
  return {
    sessionId,
    cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
    prompt,
    transcriptPath: extractTranscriptPath(payload),
  };
}

/** Missing/unreadable manifests leave managed bridge files unverifiable. */
export async function manifestSha256(home: string, kind: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, ".37soul", "install-manifest.json"), "utf8")) as {
      entries?: Array<{ kind?: string; sha256?: unknown }>;
    };
    for (const entry of parsed.entries ?? []) {
      if (entry.kind === kind && typeof entry.sha256 === "string") return entry.sha256;
    }
  } catch {
    // no manifest / unreadable: the file is treated as unverifiable (backed up)
  }
  return undefined;
}

export async function readTextSafe(file: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

export async function dirCheck(name: string, dir: string): Promise<HostDoctorCheck> {
  try {
    const info = await stat(dir);
    return { name, ok: info.isDirectory(), detail: dir };
  } catch {
    return { name, ok: false, detail: `${dir} (not found — has this agent run yet?)` };
  }
}
