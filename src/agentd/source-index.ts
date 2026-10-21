/**
 * Task 10c: the local raw-transcript source index.
 *
 * The hook emits opaque random `event_ref`s, and there is no ref -> raw bytes
 * mapping until a pointer is recorded. This module closes that gap without ever
 * moving transcript *text*: it persists a **path pointer** (mode 0600) from a
 * runtime event's `event_ref` to the host's own transcript file, and lets the
 * adapter layer read at most one bounded prefix through `readSourceRefs`.
 *
 * Privacy invariants:
 *  - A pointer record is `{runtime_kind, native_session_id, path, captured_at}` plus
 *    an optional local `end_offset` (the frozen read boundary) — a file location and
 *    byte count, never conversation text, tool output, cwd guesses or tokens.
 *  - The path is accepted only when it is an absolute, existing, regular file.
 *    `extractTranscriptPath` picks it out of the hook payload verbatim; nothing is
 *    ever synthesized for a runtime that does not hand one over.
 *  - Reading is bounded (MAX_SOURCE_BYTES prefix) and local-only: no network, no
 *    copy, no write. The returned text goes straight to the adapter's local model
 *    invocation and never into an outbox envelope, receipt or log.
 *  - The directory is bounded and pruned (newest N per session, drop older than
 *    MAX_POINTER_AGE_MS) so it cannot grow without limit.
 */
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { RuntimeKind } from "../assets/protocol.js";

/** At most this many bytes of a transcript are read, and only that prefix is returned. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
/** Keep at most this many pointers per native session. */
export const MAX_POINTERS_PER_SESSION = 32;
/** Drop pointers older than this (7 days). */
export const MAX_POINTER_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * Candidate transcript-location fields accepted from the hook payload (verbatim).
 * `source_path` is the internal field the assets-mode hook re-emits into the writer
 * payload (see hook.ts); the others are the runtime's own native spellings.
 */
const TRANSCRIPT_PATH_FIELDS = [
  "transcript_path",
  "rollout_path",
  "rolloutPath",
  "transcriptPath",
  "source_path",
] as const;

export interface SourcePointerRecord {
  runtime_kind: RuntimeKind;
  native_session_id: string;
  /** Absolute path to the host's own transcript file. A location only, never text. */
  path: string;
  captured_at: string;
  /**
   * Exclusive byte boundary frozen when the completed-turn event was captured.
   * Later appends cannot push the frozen turn out of the bounded window. This is
   * local-only: it is never copied into a watermark, outbox envelope or log.
   */
  end_offset?: number;
}

function isByteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function sourcesDir(root: string): string {
  return path.join(root, "sources");
}

/** Production event refs are `randomUUID()`: hyphenated 8-4-4-4-12 hex. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A single path segment that can never escape its directory (no separators/traversal). */
function isSafeSegment(value: string): boolean {
  if (value.length === 0 || value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  return true;
}

/** A profile id is safe only as a single path segment — never empty, never a traversal. */
export function isSafeProfileId(value: string): boolean {
  return isSafeSegment(value);
}

/** An event ref must be a single safe segment AND a UUID (it is randomUUID() in prod). */
export function isSafeEventRef(value: string): boolean {
  return isSafeSegment(value) && UUID_RE.test(value);
}

function profileDir(root: string, profileId: string): string {
  return path.join(sourcesDir(root), profileId);
}

function pointerPath(root: string, profileId: string, eventRef: string): string {
  return path.join(profileDir(root, profileId), `${eventRef}.json`);
}

/**
 * Pull the transcript location out of the hook payload, verbatim. Returns null when
 * the payload has no such field — a runtime that never reports its transcript is
 * never indexed (no fabrication for codex/opencode/hermes).
 */
export function extractTranscriptPath(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const field of TRANSCRIPT_PATH_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** Accept only an absolute path naming an existing regular file. Never guess from cwd. */
export async function validateTranscriptPath(candidate: string): Promise<string | null> {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const info = await stat(candidate);
    return info.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Persist a path pointer for an event ref. Atomic temp+rename in the profile dir,
 * mode 0600, then prune so the directory stays bounded. Errors are swallowed by the
 * caller's fire-and-forget emission path — a missing pointer never fails a session.
 */
export async function captureSourcePointer(
  root: string,
  profileId: string,
  eventRef: string,
  record: SourcePointerRecord,
): Promise<void> {
  const dir = profileDir(root, profileId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = pointerPath(root, profileId, eventRef);
  const temp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  // Freeze the read boundary at capture time unless the caller (the hook) already
  // read the file and handed over the exact endpoint it observed.
  let end = isByteOffset(record.end_offset) ? record.end_offset : undefined;
  if (end === undefined) {
    try {
      const info = await stat(record.path);
      if (info.isFile() && isByteOffset(info.size)) end = info.size;
    } catch {
      // A vanished file keeps the pointer path-only; the reader reports honestly.
    }
  }
  const persisted: SourcePointerRecord = { ...record };
  if (end !== undefined) persisted.end_offset = end;
  else delete persisted.end_offset;
  await writeFile(temp, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  await rename(temp, target);
  await pruneSourcePointers(root, profileId, record.native_session_id);
}

/**
 * Bound the pointer directory: keep the newest MAX_POINTERS_PER_SESSION per session
 * and drop anything older than MAX_POINTER_AGE_MS. Unreadable pointers are dropped.
 */
export async function pruneSourcePointers(root: string, profileId: string, sessionId: string): Promise<void> {
  const dir = profileDir(root, profileId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  const now = Date.now();
  const rows: Array<{ full: string; record: SourcePointerRecord; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const record = JSON.parse(await readFile(full, "utf8")) as SourcePointerRecord;
      if (typeof record.path !== "string" || typeof record.native_session_id !== "string") {
        await rm(full, { force: true }).catch(() => {});
        continue;
      }
      const info = await stat(full);
      rows.push({ full, record, mtimeMs: info.mtimeMs });
    } catch {
      await rm(full, { force: true }).catch(() => {});
    }
  }

  const sessionRows = rows
    .filter((row) => row.record.native_session_id === sessionId)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const drop = new Set<string>();
  for (const row of sessionRows.slice(MAX_POINTERS_PER_SESSION)) drop.add(row.full);
  for (const row of rows) {
    if (now - row.mtimeMs > MAX_POINTER_AGE_MS) drop.add(row.full);
  }
  for (const full of drop) await rm(full, { force: true }).catch(() => {});
}

/**
 * Resolve event refs in order through the pointer index and return the bounded
 * window of the first resolvable transcript, honoring a frozen endpoint when the
 * pointer has one. Returns "" when no pointer (or no underlying file) exists. No
 * network, no copy, no write.
 */
export async function readSourceRefs(root: string, refs: readonly string[], turnRefs?: readonly string[]): Promise<string> {
  for (const ref of refs) {
    if (typeof ref !== "string" || ref === "") continue;
    const content = await readSourceRef(root, ref, turnRefs);
    if (content !== null) return content;
  }
  return "";
}

async function readSourceRef(root: string, eventRef: string, turnRefs?: readonly string[]): Promise<string | null> {
  let profileDirs: string[];
  try {
    profileDirs = (await readdir(sourcesDir(root), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  for (const profileId of profileDirs) {
    let record: SourcePointerRecord;
    try {
      record = JSON.parse(await readFile(pointerPath(root, profileId, eventRef), "utf8")) as SourcePointerRecord;
    } catch {
      continue; // no pointer under this profile id (refs are opaque UUIDs, at most one matches)
    }
    try {
      const info = await stat(record.path);
      if (!info.isFile()) continue; // the pointed file is gone or not regular
    } catch {
      continue;
    }
    return readSourceWindow(record.path, MAX_SOURCE_BYTES, turnRefs, record.end_offset);
  }
  return null;
}

/**
 * Read a bounded tail of a host transcript (no whole-file read) together with the
 * exact byte boundary that was observed. The hook freezes that boundary for the
 * completed turn so later appends cannot evict it from a future tail window.
 */
export interface SourceTailWindow {
  text: string;
  /** Inclusive byte offset the window starts at. */
  start: number;
  /** Exclusive byte offset the window ends at (the file size observed). */
  end: number;
}

export async function readSourceTailWindow(
  file: string,
  maxBytes = MAX_SOURCE_BYTES,
): Promise<SourceTailWindow | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const end = info.size;
    const start = Math.max(0, end - maxBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, end));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return { text, start, end };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function readSourceTail(file: string, maxBytes = MAX_SOURCE_BYTES): Promise<string> {
  const window = await readSourceTailWindow(file, maxBytes);
  return window?.text ?? "";
}

/** Does a complete JSONL window contain every requested host turn ref? */
function windowContainsTurnRefs(text: string, turnRefs: readonly string[]): boolean {
  if (turnRefs.length === 0) return true;
  const wanted = new Set(turnRefs);
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue; // a partial boundary line is not evidence
    }
    for (const key of ["uuid", "id", "ordinal"]) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") found.add(String(value));
    }
  }
  return [...wanted].every((ref) => found.has(ref));
}

/**
 * Bounded source window for a completed turn. Short files are returned in full
 * (up to maxBytes). Long files are read from the tail so the just-completed turn
 * is included; a partial first line is discarded and every requested host turn ref
 * must be present, otherwise the adapter gets "" and reports source_unavailable.
 * The file location never leaves the machine; only this bounded text reaches the
 * local adapter.
 */
async function readSourceWindow(
  file: string,
  maxBytes: number,
  turnRefs?: readonly string[],
  endOffset?: number,
): Promise<string | null> {
  // Legacy callers without frozen turn refs get the bounded tail (short files are
  // whole). Production extraction passes turnRefs and still verifies every ref.
  if (!turnRefs || turnRefs.length === 0) return readSourceTail(file, maxBytes);
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    // A frozen boundary is authoritative: read exactly the prefix the completed
    // turn was captured against. If the file shrank below it, the frozen bytes no
    // longer exist — fail honestly instead of silently reading a different tail.
    const frozen = isByteOffset(endOffset);
    if (frozen && info.size < endOffset) return "";
    const end = frozen ? endOffset : info.size;
    const start = Math.max(0, end - maxBytes);
    const length = Math.min(maxBytes, end - start);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) return ""; // concurrent truncation: no stable window
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return windowContainsTurnRefs(text, turnRefs) ? text : "";
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Read at most `maxBytes` from the start of `file` and return that prefix as UTF-8,
 * or `null` when the file cannot be read. TOCTOU-safe: the file is opened with
 * O_NONBLOCK (so a FIFO swapped in after the caller's stat can never block the
 * drain), re-verified with an fstat, and any open/read error degrades to `null`
 * exactly like the missing-file path instead of throwing and burning an attempt.
 */
async function readPrefix(file: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return null; // a non-regular file (e.g. FIFO) appeared between stat and open
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return null; // ENOENT (deleted between stat and open) or any read error: skip this ref
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
