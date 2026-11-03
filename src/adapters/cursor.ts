import type { AdapterDeps, RuntimeAdapter } from "./types.js";

export const CURSOR_EXTRACTION_BLOCKER = "Cursor extraction unavailable: cursor-agent --print has write/shell tools; no verified per-invocation switch disables every tool and MCP server. Omitting --force or selecting ask/plan is not a no-tools guarantee. No model invocation attempted.";

export function createCursorAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "cursor",
    async probe() {
      return { runtime_kind: "cursor", version: "0.0.0-unverified", session_id: false, before_request: false,
        structured_extraction: false, internal_marker: false, resume: false, compact: false, interrupt: false };
    },
    async extract(request) {
      const source = await deps.readSource(request.source_event_refs, request.source_turn_refs);
      if (!source.trim()) return { error: { code: "source_unavailable", retryable: true } };
      return { error: { code: "cursor_tool_free_extraction_unavailable", retryable: false } };
    },
    async inject() {
      return { delivered: false, rendered_sha256: "", error: "cursor_injection_unverified" };
    },
  };
}
