import type { AdapterDeps, RuntimeAdapter } from "./types.js";

/**
 * Kiro CLI's hook surface gives us identity and per-session context, but its
 * command surface exposes shell and MCP tools. No Kiro invocation verified here
 * can prove that every tool and MCP server is disabled for one extraction job,
 * so automatic memory extraction stays off instead of silently running tools.
 */
export const KIRO_EXTRACTION_BLOCKER = "Kiro extraction unavailable: no verified non-interactive invocation disables Kiro's shell and MCP tools for one job. A hook configuration write does not make extraction tool-free. No model invocation attempted.";

export function createKiroAdapter(deps: AdapterDeps): RuntimeAdapter {
  return {
    runtime_kind: "kiro",
    async probe() {
      return { runtime_kind: "kiro", version: "0.0.0-unverified", session_id: false, before_request: false,
        structured_extraction: false, internal_marker: false, resume: false, compact: false, interrupt: false };
    },
    async extract(request) {
      const source = await deps.readSource(request.source_event_refs, request.source_turn_refs);
      if (!source.trim()) return { error: { code: "source_unavailable", retryable: true } };
      return { error: { code: "kiro_tool_free_extraction_unavailable", retryable: false } };
    },
    async inject() {
      return { delivered: false, rendered_sha256: "", error: "kiro_injection_unverified" };
    },
  };
}
