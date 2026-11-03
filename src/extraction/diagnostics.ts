import type { ExtractionDiagnostic } from "../adapters/types.js";
/** Fixed allowlist: never interpolate arbitrary provider output or payload fields. */
export function formatExtractionDiagnostic(counts: ExtractionDiagnostic): string {
  const n = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  switch (counts.stage) {
    case "source": return `extraction source: user ${n(counts.user_messages)}, assistant ${n(counts.assistant_messages)}, tool ${n(counts.tool_messages)}`;
    case "parse": return `extraction parse: received ${n(counts.proposals_received)}, parsed ${n(counts.proposals_parsed)}, dropped ${n(counts.proposals_dropped)}`;
    case "commit": return `extraction commit: received ${n(counts.proposals_received)}, accepted ${n(counts.proposals_accepted)}, rejected ${n(counts.proposals_rejected)}, queued ${n(counts.proposals_queued)}`;
  }
}
