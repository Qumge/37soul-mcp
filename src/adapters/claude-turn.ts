/** Pure, bounded JSONL completion inspection. No IO and no raw persistence. */
import { isSkippedRecord } from "../agentd/parsers/claude-code.js";

export interface TurnObservation {
  root_ref: string;
  root_offset: number;
  state: "incomplete" | "completed" | "invalid";
  refs: string[];
  /** Exclusive byte offset of the terminal assistant record, relative to input. */
  end_offset?: number;
}

/** A human boundary is independent of whether its content is extractable text.
 * Image/audio/attachment/empty user turns must close an older pinned turn too.
 * Only a user record made entirely of tool_result blocks is a continuation.
 */
function human(record: Record<string, any>): boolean {
  if (record.type !== "user" || record.isSidechain === true || record.isMeta === true) return false;
  const content = record.message?.content;
  return !(Array.isArray(content) && content.length > 0 && content.every(block => block?.type === "tool_result"));
}

function hasHumanText(record: Record<string, any>): boolean {
  const content = record.message?.content;
  return typeof content === "string" ? content.trim() !== "" : Array.isArray(content) &&
    content.some(block => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
}

/** Stop is the lifecycle witness. Missing legacy stop_reason is compatible with
 * Stop; explicit streaming/null/tool/max-token reasons are never completion.
 * Thinking-only records may carry end_turn, so terminal assistant TEXT is required.
 * A deferred root is selected by UUID, never by whatever turn happens to be latest.
 */
export function observeClaudeTurn(text: string, rootRef?: string): TurnObservation | null {
  const rows: Array<{ record: Record<string, any>; start: number; end: number }> = [];
  const malformed: number[] = [];
  let offset = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const terminated = index < lines.length - 1;
    const end = offset + Buffer.byteLength(line) + (terminated ? 1 : 0);
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) rows.push({ record, start: offset, end });
      else malformed.push(offset);
    } catch {
      // A complete EOF JSON object is a record even without a final newline.
      // A genuinely torn suffix is deferred; malformed interior lines fail closed.
      if (terminated && line.trim() !== "") malformed.push(offset);
    }
    offset = end;
  }
  const roots = rows.filter(row => human(row.record));
  const root = rootRef === undefined ? roots.at(-1) : roots.find(row => row.record.uuid === rootRef);
  if (!root || typeof root.record.uuid !== "string" || root.record.uuid === "" || !hasHumanText(root.record)) return null;
  const result: TurnObservation = { root_ref: root.record.uuid, root_offset: root.start, state: "incomplete", refs: [] };
  const rootIndex = rows.indexOf(root);
  const nextHuman = rows.findIndex((row, index) => index > rootIndex && human(row.record));
  const limit = nextHuman < 0 ? rows.length : nextHuman;
  if (malformed.some(start => start >= root.start && (nextHuman < 0 || start < rows[nextHuman].start))) return {...result, state: "invalid"};
  const turn = rows.slice(rootIndex, limit);
  const children = new Map<string, typeof rows>();
  const ids = new Set<string>();
  for (const row of turn) {
    const r = row.record;
    if (r.isSidechain === true || r.isMeta === true) continue;
    if (typeof r.uuid === "string") {
      if (ids.has(r.uuid)) return { ...result, state: "invalid" };
      ids.add(r.uuid);
    }
    if (!(r.attachment != null || r.type === "assistant" || r.type === "user")) continue;
    if (r.attachment == null && isSkippedRecord(r)) continue;
    if (typeof r.parentUuid === "string") {
      const list = children.get(r.parentUuid) ?? [];
      list.push(row); children.set(r.parentUuid, list);
    }
  }
  let row = root;
  let terminal = false;
  let end: number | undefined;
  const seen = new Set<string>();
  while (row) {
    const r = row.record;
    if (typeof r.uuid !== "string" || seen.has(r.uuid)) return { ...result, state: "invalid" };
    seen.add(r.uuid);
    if (r.attachment == null) {
      result.refs.push(r.uuid);
      const blocks = r.message?.content;
      terminal = r.type === "assistant" && Array.isArray(blocks) &&
        blocks.some(block => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") &&
        !blocks.some(block => block?.type === "tool_use") &&
        (r.message.stop_reason === undefined || r.message.stop_reason === "end_turn" || r.message.stop_reason === "stop_sequence");
      end = row.end;
    }
    const next = children.get(r.uuid) ?? [];
    if (next.length > 1) return { ...result, state: "invalid" };
    if (next.length === 0) break;
    // Appended descendants must follow their parent in the native file.
    if (next[0].start <= row.start) return { ...result, state: "invalid" };
    row = next[0];
  }
  if (terminal) return { ...result, state: "completed", end_offset: end };
  return { ...result, state: nextHuman < 0 ? "incomplete" : "invalid" };
}
