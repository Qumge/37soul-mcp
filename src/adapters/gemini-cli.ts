/** Native Gemini extraction is deliberately unavailable until isolated tool denial is verified. */
import type { AdapterDeps, RuntimeAdapter } from "./types.js";

export const GEMINI_CLI_EXTRACTION_BLOCKER = "Gemini extraction unavailable: --policy deny-all is User tier and can be overridden by Admin allow rules; --admin-policy is ignored when system .toml policies exist. GEMINI_CLI_SYSTEM_SETTINGS_PATH does not redirect the system policies directory. The current invocation cannot guarantee tool/MCP denial. No model invocation attempted.";

export function createGeminiCliAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "gemini-cli",
    async probe() {
      return { runtime_kind: "gemini-cli", version: "0.0.0-unverified", session_id: false, before_request: false,
        structured_extraction: false, internal_marker: false, resume: false, compact: false, interrupt: false };
    },
    async extract(request) {
      const source = await deps.readSource(request.source_event_refs, request.source_turn_refs);
      if (!source.trim()) return { error: { code: "source_unavailable", retryable: true } };
      return { error: { code: "gemini_cli_tool_free_extraction_unverified", retryable: false } };
    },
    async inject() {
      return { delivered: false, rendered_sha256: "", error: "gemini_cli_injection_unverified" };
    },
  };
}

/**
 * Source pointers stay local. Recognize legacy JSON and simple native JSONL IDs,
 * but fail closed on patched/rewound formats until their replay is implemented.
 * This is not a transcript reader or a claim that model extraction is available.
 */
export function latestGeminiCompletedTurnRefs(text: string): string[] {
  let messages: any[];
  try {
    const record = JSON.parse(text);
    if (!record || !Array.isArray(record.messages)) return [];
    messages = record.messages;
  } catch {
    try {
      const records = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
      if (records.some(record => !record || typeof record !== "object" || Array.isArray(record) ||
          "$patch" in record || "$rewindTo" in record)) return [];
      messages = records.filter(record => record.type === "user" || record.type === "gemini");
    } catch { return []; }
  }
  if (!messages.every(record => record && typeof record === "object" && !Array.isArray(record))) return [];
  let start = messages.length - 1;
  while (start >= 0 && messages[start].type !== "user") start--;
  if (start < 0) return [];
  const turn = messages.slice(start);
  if (turn.length < 2 || turn.at(-1)?.type !== "gemini") return [];
  if (turn.some(record => !["user", "gemini"].includes(record.type) || typeof record.id !== "string" || !record.id.trim()) ||
      new Set(turn.map(record => record.id)).size !== turn.length) return [];
  return turn.map(record => record.id);
}
