/**
 * Local recall: answer "what does she remember about X?" from the assets we already
 * hold, without a model call.
 *
 * Why not vectors: a profile holds tens of assets, not hundreds of thousands. Keyword
 * + trait + applicability matching is deterministic, explainable, free, and keeps the
 * same ordering rules the injector already uses (pinned first, then active, then
 * candidates; tombstones only when asked for). A vector index here would be a second
 * source of truth that can silently disagree with what gets injected.
 *
 * Scope: `active` and `candidate` only (what she would actually use). `superseded` /
 * `rejected` / `deleted` are history — included only with `includeHistory`, and always
 * marked, because "she remembers this" and "this was true once" are different claims.
 */
import type { Asset, AssetState } from "./protocol.js";

export interface RecallQuery {
  /** Free-text terms; every term must match content, applicability or a tag (AND). */
  terms: string[];
  /** Restrict to one asset kind. */
  kind?: "relationship" | "experience";
  /** Include tombstoned/history states (superseded, rejected, deleted). */
  includeHistory?: boolean;
  limit?: number;
}

export interface RecallHit {
  asset: Asset;
  /** Why it matched: which field(s) the terms landed in, for explainable output. */
  matched: Array<"content" | "applicability" | "tag" | "trait">;
  /** Lower sorts first: pinned, then active before candidate, then newest revision. */
  rank: number;
}

const HISTORY_STATES: AssetState[] = ["superseded", "rejected", "deleted"];

function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/** Split a query into NFC-lowercased terms; JSON/CLI friendly (no stemming, no stopwords). */
export function parseTerms(query: string): string[] {
  return normalize(query)
    .split(/[\s,，、;；]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function rankOf(asset: Asset): number {
  const stateRank = asset.state === "active" ? 1 : asset.state === "candidate" ? 2 : 3;
  const pinnedRank = asset.pinned ? 0 : 1;
  return pinnedRank * 10 + stateRank;
}

/**
 * Pure function so it can be tested without a store; the CLI only loads the snapshot.
 * A term matches when it appears in content, applicability, a tag, or the trait name.
 */
export function recallAssets(assets: readonly Asset[], query: RecallQuery): RecallHit[] {
  const terms = query.terms.map(normalize).filter((term) => term.length > 0);
  const includeHistory = query.includeHistory === true;
  const limit = query.limit && query.limit > 0 ? query.limit : 10;

  const hits: RecallHit[] = [];
  for (const asset of assets) {
    if (query.kind && asset.kind !== query.kind) continue;
    const isHistory = HISTORY_STATES.includes(asset.state);
    if (isHistory && !includeHistory) continue;

    const content = normalize(asset.content);
    const applicability = normalize(asset.applicability ?? "");
    const tags = (asset.tags ?? []).map(normalize);
    const trait = normalize(asset.trait);

    const matched: RecallHit["matched"] = [];
    let allMatched = terms.length > 0;
    for (const term of terms) {
      let hit = false;
      if (content.includes(term)) {
        if (!matched.includes("content")) matched.push("content");
        hit = true;
      }
      if (applicability.includes(term)) {
        if (!matched.includes("applicability")) matched.push("applicability");
        hit = true;
      }
      if (tags.some((tag) => tag.includes(term))) {
        if (!matched.includes("tag")) matched.push("tag");
        hit = true;
      }
      if (trait.includes(term)) {
        if (!matched.includes("trait")) matched.push("trait");
        hit = true;
      }
      if (!hit) {
        allMatched = false;
        break;
      }
    }

    // An empty query lists everything (like `37soul recall` with no terms).
    if (terms.length > 0 && !allMatched) continue;
    hits.push({ asset, matched, rank: rankOf(asset) });
  }

  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const at = Date.parse(a.asset.source.occurred_at ?? "") || 0;
    const bt = Date.parse(b.asset.source.occurred_at ?? "") || 0;
    return bt - at;
  });
  return hits.slice(0, limit);
}

/** One terminal line per hit: state, kind/trait, content, where it came from. */
export function formatRecallHit(hit: RecallHit): string {
  const { asset } = hit;
  const state = asset.state === "active" ? "" : ` [${asset.state}]`;
  const pin = asset.pinned ? " 📌" : "";
  const when = asset.source.occurred_at ? asset.source.occurred_at.slice(0, 10) : "unknown";
  const via = asset.source.runtime_kind ?? "unknown";
  const why = hit.matched.length > 0 ? ` (matched: ${hit.matched.join(", ")})` : "";
  return `${state}${pin} ${asset.kind}/${asset.trait} · ${asset.content} · ${when} · ${via}${why}`.trim();
}
