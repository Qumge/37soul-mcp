/**
 * Runtime probe entry point (P0). `probeRuntime` delegates to the adapter's own
 * probe and sanity-checks that the reported runtime_kind matches the adapter, so
 * a mis-wired adapter cannot silently report evidence for another tool.
 *
 * Task 6–9 supply the four real adapters; the offline probe script only ever uses
 * the fake runtime until a real adapter is in place and an authorized live probe
 * is run. A tool whose probe only observes hooks and cannot call a model must
 * report structured_extraction=false and does not pass P0.
 */
import type { RuntimeAdapter, RuntimeProbe } from "./types.js";

export async function probeRuntime(adapter: RuntimeAdapter): Promise<RuntimeProbe> {
  const result = await adapter.probe();
  if (result.runtime_kind !== adapter.runtime_kind) {
    throw new Error(
      `probe runtime_kind mismatch: adapter ${adapter.runtime_kind}, probe ${result.runtime_kind}`,
    );
  }
  return result;
}
