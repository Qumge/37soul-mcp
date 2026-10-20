/**
 * Offline fake RuntimeAdapter used by the probe script and adapter tests.
 *
 * It exercises the exact RuntimeAdapter surface (probe/extract/inject) without
 * touching any real host tool or model, so contract and probe work can run on
 * Node 18/20/24 with no network, no installed agents and no user HOME writes.
 * Task 6–9 replace these fakes with the four real adapters after authorized
 * live probes.
 */
import { createHash } from "node:crypto";

export const RUNTIME_KINDS = ["claude-code", "codex", "opencode", "hermes"];

/**
 * @param {"claude-code"|"codex"|"opencode"|"hermes"} runtime_kind
 * @param {{probe?: object, extract?: Function, inject?: Function}} [overrides]
 */
export function createFakeAdapter(runtime_kind, overrides = {}) {
  const probe = {
    runtime_kind,
    version: "0.0.0-offline-fake",
    session_id: true,
    before_request: true,
    structured_extraction: true,
    internal_marker: true,
    resume: true,
    compact: true,
    interrupt: true,
    ...(overrides.probe ?? {}),
  };

  return {
    runtime_kind,

    async probe() {
      return { ...probe };
    },

    async extract(request) {
      if (overrides.extract) return overrides.extract(request);
      // Structured, bounded result: the fake proves the interface, never reads
      // anything beyond the frozen source_event_refs in `request`.
      return { proposals: [] };
    },

    async inject(bundle) {
      if (overrides.inject) return overrides.inject(bundle);
      // Local receipt only: delivered flag + the rendered text's SHA-256.
      const rendered_sha256 = createHash("sha256").update(bundle.rendered_text ?? "", "utf8").digest("hex");
      return { delivered: true, rendered_sha256 };
    },
  };
}
