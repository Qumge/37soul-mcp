/**
 * The shared context selector + fixed renderer (§7).
 *
 * `selectContext(input)` implements the same selection/rules as the Rails
 * SoulContextSelector: active-only, tombstone suppression with explicit restore,
 * quarantine of unconfirmed local proposals, relevance scoring, the
 * pinned→score→revision→uid sort, the relationship/experience caps, and the
 * byte-budgeted fixed renderer. The golden fixtures pin exact rendered_text,
 * UTF-8 byte length and SHA-256, so any drift here fails the contract tests.
 */
import type {
  Asset,
  AssetTombstone,
  ContextBundle,
  ContextInput,
  ContextManifestEntry,
  Identity,
} from "./protocol.js";
import {
  ASSET_TOMBSTONE_STATES,
  LIMITS,
  contentDigest,
} from "./protocol.js";

const IDENTITY_HEADER = "[Soul]\n";
const RELATIONSHIP_HEADER = "[Relationship]\n";
const EXPERIENCE_HEADER = "[Experience]\n";

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * §7 JSON string escaping: NFC-normalized, never escape non-ASCII or "/", escape
 * double quotes and backslashes, and use standard short escapes with lowercase
 * hex `\u00xx` for other ASCII control characters.
 */
function jsonString(value: string): string {
  const nfc = value.normalize("NFC");
  let out = '"';
  for (const ch of nfc) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = ch.codePointAt(0);
        if (code !== undefined && code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return out + '"';
}

function identityLine(identity: Identity): string {
  return (
    `{"name":${jsonString(identity.name)},` +
    `"description":${jsonString(identity.description)},` +
    `"character":${jsonString(identity.character)},` +
    `"greeting":${jsonString(identity.greeting)}}`
  );
}

function relationshipLine(asset: Asset): string {
  return (
    `{"asset_uid":${jsonString(asset.asset_uid)},"revision":${asset.revision},` +
    `"content":${jsonString(asset.content)},"applicability":${jsonString(asset.applicability)}}`
  );
}

function experienceLine(asset: Asset): string {
  return (
    `{"asset_uid":${jsonString(asset.asset_uid)},"revision":${asset.revision},` +
    `"content":${jsonString(asset.content)},"applicability":${jsonString(asset.applicability)},` +
    `"verification":${jsonString(asset.verification)}}`
  );
}

/**
 * Render the identity section within min(8192, budget). If the full section does
 * not fit, remove trailing code points from character, then greeting, then
 * description, then name — whole code points only — until it encodes within the
 * budget. Returns the rendered section and whether any trimming happened.
 */
function renderIdentity(identity: Identity, budget: number): { text: string; trimmed: boolean } {
  const fields: Record<"name" | "description" | "character" | "greeting", string> = {
    name: identity.name,
    description: identity.description,
    character: identity.character,
    greeting: identity.greeting,
  };
  const trimOrder: Array<keyof typeof fields> = ["character", "greeting", "description", "name"];
  const build = () => IDENTITY_HEADER + identityLine(fields) + "\n";

  let text = build();
  let trimmed = false;
  while (utf8Bytes(text) > budget) {
    let removed = false;
    for (const key of trimOrder) {
      if (fields[key].length === 0) continue;
      const points = Array.from(fields[key]);
      points.pop();
      fields[key] = points.join("");
      removed = true;
      break;
    }
    if (!removed) break;
    trimmed = true;
    text = build();
  }
  return { text, trimmed };
}

/** NFC + Unicode lowercase, used for both task hint and asset text. */
function normalizeText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * §7 relevance words: NFC + lowercase the task hint, then take consecutive Latin
 * letter/digit runs of length >= 2 plus every adjacent Han bigram, in first-seen
 * order, deduplicated, capped at 32.
 */
function relevanceWords(taskHint: string): string[] {
  const text = normalizeText(taskHint);
  const words: string[] = [];
  const seen = new Set<string>();
  const push = (word: string) => {
    if (seen.has(word)) return;
    seen.add(word);
    if (words.length < LIMITS.relevanceWordsMax) words.push(word);
  };

  const runPattern = /[a-z0-9]+|[\p{Script=Han}]+/gu;
  for (const match of text.matchAll(runPattern)) {
    const run = match[0];
    if (/^[a-z0-9]+$/.test(run)) {
      if (run.length >= 2) push(run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) {
        push(run.slice(i, i + 2));
      }
    }
  }
  return words;
}

function assetScore(asset: Asset, words: readonly string[]): number {
  if (words.length === 0) return 0;
  const fields = [asset.content, asset.applicability, ...(asset.tags ?? [])].map(normalizeText);
  let score = 0;
  for (const word of words) {
    if (fields.some((field) => field.includes(word))) score += 1;
  }
  return score;
}

function tombstoneDigest(item: Asset | AssetTombstone): string {
  const asTombstone = item as AssetTombstone;
  if (typeof asTombstone.content_digest === "string" && asTombstone.content_digest !== "") {
    return asTombstone.content_digest;
  }
  const asAsset = item as Asset;
  return typeof asAsset.content === "string" ? contentDigest(asAsset.content) : "";
}

interface SelectedAsset {
  asset: Asset;
  score: number;
}

function selectAssets(input: ContextInput): { relationships: Asset[]; experiences: Asset[] } {
  const words = relevanceWords(input.taskHint);
  const quarantined = new Set(input.quarantinedAssetUids ?? []);

  const active: Asset[] = [];
  const tombstonesByKey = new Map<string, AssetTombstone[]>();
  for (const item of input.assets) {
    if (item.state === "active") {
      active.push(item as Asset);
    } else if ((ASSET_TOMBSTONE_STATES as readonly string[]).includes(item.state)) {
      const tombstone = item as AssetTombstone;
      const key = `${tombstone.kind}\u0000${tombstone.trait}\u0000${tombstoneDigest(item)}`;
      const list = tombstonesByKey.get(key) ?? [];
      list.push(tombstone);
      tombstonesByKey.set(key, list);
    }
  }

  const selectable: SelectedAsset[] = [];
  for (const asset of active) {
    if (quarantined.has(asset.asset_uid)) continue;
    const digest = asset.content_digest ?? contentDigest(asset.content);
    const key = `${asset.kind}\u0000${asset.trait}\u0000${digest}`;
    const tombstones = tombstonesByKey.get(key);
    if (tombstones && tombstones.length > 0) {
      const released = tombstones.every((t) => t.restored_by_uid === asset.asset_uid);
      if (!released) continue;
    }
    selectable.push({ asset, score: assetScore(asset, words) });
  }

  selectable.sort((a, b) => {
    const pinnedDiff = Number(b.asset.pinned) - Number(a.asset.pinned);
    if (pinnedDiff !== 0) return pinnedDiff;
    if (a.score !== b.score) return b.score - a.score;
    if (a.asset.revision !== b.asset.revision) return b.asset.revision - a.asset.revision;
    if (a.asset.asset_uid < b.asset.asset_uid) return -1;
    if (a.asset.asset_uid > b.asset.asset_uid) return 1;
    return 0;
  });

  const relationships = selectable
    .filter((entry) => entry.asset.kind === "relationship")
    .map((entry) => entry.asset)
    .slice(0, LIMITS.relationshipMax);
  const experiences = selectable
    .filter((entry) => entry.asset.kind === "experience" && (entry.asset.pinned || entry.score > 0))
    .map((entry) => entry.asset)
    .slice(0, LIMITS.experienceMax);

  return { relationships, experiences };
}

function clampBudget(budgetBytes?: number): number {
  if (budgetBytes === undefined || !Number.isFinite(budgetBytes)) return LIMITS.budgetMax;
  return Math.min(LIMITS.budgetMax, Math.max(LIMITS.budgetMin, Math.floor(budgetBytes)));
}

export function selectContext(input: ContextInput): ContextBundle {
  const budget = clampBudget(input.budgetBytes);
  const identityBudget = Math.min(LIMITS.identityBudgetMax, budget);

  const identity = renderIdentity(input.soul.identity, identityBudget);
  let remaining = budget - utf8Bytes(identity.text);
  let truncated = identity.trimmed;

  const { relationships, experiences } = selectAssets(input);
  const manifest: ContextManifestEntry[] = [];
  let output = identity.text;

  let relationshipHeaderEmitted = false;
  for (const asset of relationships) {
    const line = relationshipLine(asset) + "\n";
    const header = relationshipHeaderEmitted ? "" : RELATIONSHIP_HEADER;
    if (utf8Bytes(header) + utf8Bytes(line) <= remaining) {
      output += header + line;
      remaining -= utf8Bytes(header) + utf8Bytes(line);
      relationshipHeaderEmitted = true;
      manifest.push({ asset_uid: asset.asset_uid, revision: asset.revision });
    } else {
      truncated = true;
    }
  }

  let experienceHeaderEmitted = false;
  for (const asset of experiences) {
    const line = experienceLine(asset) + "\n";
    const header = experienceHeaderEmitted ? "" : EXPERIENCE_HEADER;
    if (utf8Bytes(header) + utf8Bytes(line) <= remaining) {
      output += header + line;
      remaining -= utf8Bytes(header) + utf8Bytes(line);
      experienceHeaderEmitted = true;
      manifest.push({ asset_uid: asset.asset_uid, revision: asset.revision });
    } else {
      truncated = true;
    }
  }

  return {
    soul_uid: input.soul.soul_uid,
    identity_revision: input.soul.identity_revision,
    binding_uid: input.binding.binding_uid,
    binding_revision: input.binding.revision,
    manifest,
    rendered_text: output,
    truncated,
  };
}
