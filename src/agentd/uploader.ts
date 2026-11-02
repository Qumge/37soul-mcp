/** Legacy transcript upload is retired. No credential or account mode can enable it. */
import type { QueuedUpload } from "./queue.js";

export interface UploaderDeps {
  fetch: typeof fetch;
  baseUrl: string;
  tokenFor: (agentKind: string) => string | null;
  log?: { info: (m: string) => void; error: (m: string) => void };
}

/** Explicit refusal retained for callers holding old queued items; never reads tokens or data. */
export async function uploadBatch(_deps: UploaderDeps, _item: QueuedUpload): Promise<{ status: "retired"; error: string }> {
  return { status: "retired", error: "Legacy transcript upload is retired; use soul-assets/v1." };
}
