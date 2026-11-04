import { VALIDATION_REJECTION_REASONS } from "../assets/validation.js";
import type { ExtractionDiagnostic } from "../adapters/types.js";
/** Fixed allowlist: never interpolate arbitrary provider output or payload fields. */
export function formatExtractionDiagnostic(counts: ExtractionDiagnostic): string {
  const n = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  switch (counts.stage) {
    case "resource": return `extraction resources: pending ${n(counts.pending)}, budget_deferred ${n(counts.budget_deferred)}, stale_binding ${n(counts.stale_pending)}, source_deferred ${n(counts.source_deferred)}`;
    case "reject": return `extraction reject: ${VALIDATION_REJECTION_REASONS.filter(reason => n(counts.reasons[reason] ?? 0) > 0).map(reason => `${reason} ${n(counts.reasons[reason] ?? 0)}`).join(", ") || "none"}`;
    case "source": return `extraction source: user ${n(counts.user_messages)}, assistant ${n(counts.assistant_messages)}, tool ${n(counts.tool_messages)}`;
    case "parse": return `extraction parse: received ${n(counts.proposals_received)}, parsed ${n(counts.proposals_parsed)}, dropped ${n(counts.proposals_dropped)}`;
    case "commit": return `extraction commit: received ${n(counts.proposals_received)}, accepted ${n(counts.proposals_accepted)}, rejected ${n(counts.proposals_rejected)}, queued ${n(counts.proposals_queued)}`;
  }
}
