/**
 * Task 5: outbox ordering + push batching for the soul-assets/v1 sync.
 *
 * The outbox is a set of immutable, topologically linked operations. Sending order
 * follows §3.1: register the Soul / open Consent first, then replay Binding changes
 * in the order they were produced, then batch the still-valid asset changes.
 * `predecessor_operation_ids` only link binding operations today, but the sort is a
 * real topological sort so a future cross-kind dependency cannot silently reorder.
 *
 * Asset changes are batched to at most `pushMaxChanges` per request and
 * `pushMaxBytes` total (the shared LIMITS), never flattened or rewritten.
 */
import { LIMITS } from "../assets/protocol.js";
import type { OutboxOperation, OutboxOperationKind } from "../local/store.js";

/** Send order by kind: register_soul → consent → binding → asset (§3.1). */
export const OPERATION_PRIORITY: Record<OutboxOperationKind, number> = {
  register_soul: 0,
  consent: 1,
  binding: 2,
  asset: 3,
};

function byPriority(a: OutboxOperation, b: OutboxOperation): number {
  return OPERATION_PRIORITY[a.operation_kind] - OPERATION_PRIORITY[b.operation_kind];
}

/**
 * Topologically order a set of pending operations. Predecessors that are still in
 * the set must be sent first; ties (and the ready queue) are broken by operation
 * kind priority, which keeps the §3.1 bootstrap order stable. A cycle / dangling
 * predecessor is degraded gracefully: those operations are appended by priority
 * rather than dropped, so a corrupted link can never strand data.
 */
export function orderOutboxOps(ops: readonly OutboxOperation[]): OutboxOperation[] {
  const byId = new Map(ops.map((op) => [op.operation_id, op]));
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();

  for (const op of ops) {
    let degree = 0;
    for (const pred of op.predecessor_operation_ids ?? []) {
      if (!byId.has(pred)) continue; // already synced: not a constraint
      degree += 1;
      const list = successors.get(pred) ?? [];
      list.push(op.operation_id);
      successors.set(pred, list);
    }
    indegree.set(op.operation_id, degree);
  }

  const ready = ops
    .filter((op) => (indegree.get(op.operation_id) ?? 0) === 0)
    .sort(byPriority);

  const out: OutboxOperation[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    out.push(next);
    for (const succ of successors.get(next.operation_id) ?? []) {
      const degree = (indegree.get(succ) ?? 1) - 1;
      indegree.set(succ, degree);
      if (degree === 0) {
        ready.push(byId.get(succ)!);
        ready.sort(byPriority);
      }
    }
  }

  if (out.length < ops.length) {
    const seen = new Set(out.map((op) => op.operation_id));
    out.push(...ops.filter((op) => !seen.has(op.operation_id)).sort(byPriority));
  }
  return out;
}

/**
 * Group asset changes into ≤50-change, ≤256 KiB batches (§5). The byte estimate is
 * the serialized change request; the full HTTP body adds a little envelope overhead,
 * so the limiter is deliberately conservative rather than a perfect byte counter.
 */
export function batchAssetOps(assetOps: readonly OutboxOperation[]): OutboxOperation[][] {
  const batches: OutboxOperation[][] = [];
  let current: OutboxOperation[] = [];
  let bytes = 0;
  for (const op of assetOps) {
    const size = Buffer.byteLength(JSON.stringify(op.request), "utf8");
    if (current.length > 0 && (current.length >= LIMITS.pushMaxChanges || bytes + size > LIMITS.pushMaxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
