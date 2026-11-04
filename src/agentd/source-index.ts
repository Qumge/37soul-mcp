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
 *    a frozen byte boundary and optional completion witness (root UUID, file
 *    identity/digest and original binding) — never conversation text, tool output,
 *    cwd guesses or tokens. Awaiting witnesses cannot be read as model sources.
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
import {pendingSessionSource} from "./session-source-hints.js";
import {createHash} from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {NativeSessionKey, SessionSourceBoundary} from "../adapters/types.js";
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

/** Strong local witness over exactly the observed byte window. Never a wire DTO. */
export interface SourceWindowIdentity {
  start: number;
  end: number;
  device: number;
  inode: number;
  sha256: string;
}
export interface TurnSourceCapture {
  root_ref: string;
  observed: SourceWindowIdentity;
  binding_uid: string;
  binding_revision: number;
  session_ref: string;
  soul_uid: string;
  device_id: string;
  state: "awaiting" | "resolved" | "scheduled" | "invalid";
  turn_refs?: string[];
}

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
  /** Local-only lower bound for an explicitly attached native session. */
  source_boundary?: SessionSourceBoundary;
  /** Awaiting Stop witness: no extraction request exists until it resolves. */
  turn_capture?: TurnSourceCapture;
  /** Immutable completed byte window, checked again at the adapter read. */
  frozen_window?: SourceWindowIdentity;
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

/** Find only this exact native session's hook-provided source; never infer from cwd. */
export async function sessionSourceBoundary(root: string, key: NativeSessionKey): Promise<SessionSourceBoundary | null> {
  const dir = profileDir(root, key.profile_id);
  const files = await readdir(dir).catch(() => []);
  const records: SourcePointerRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(path.join(dir, file), "utf8")) as SourcePointerRecord;
      if (record.runtime_kind === key.runtime_kind && record.native_session_id === key.native_session_id) records.push(record);
    } catch { /* Corrupt pointers are not evidence. */ }
  }
  const pending = await pendingSessionSource(root, key);
  records.sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
  const latest = records[0];
  const record = pending && (!latest || pending.captured_at >= latest.captured_at) ? pending : latest;
  if (!record || !path.isAbsolute(record.path)) return null;
  let handle: FileHandle | null = null;
  try {
    handle = await open(record.path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const byte = Buffer.alloc(1);
    if (info.size > 0) await handle.read(byte, 0, 1, info.size - 1);
    return {path: record.path, start_offset: info.size, device: info.dev, inode: info.ino, starts_line: info.size === 0 || byte[0] === 10, anchor_sha256: await boundaryAnchor(handle, info.size)};
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function boundaryAnchor(handle: FileHandle, offset: number): Promise<string> {
  const length = Math.min(64, offset);
  const bytes = Buffer.alloc(length);
  const read = await handle.read(bytes, 0, length, offset - length);
  if (read.bytesRead !== length) throw new Error("source boundary changed");
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sourceMatchesBoundary(file: string, boundary: SessionSourceBoundary): Promise<boolean> {
  if (file !== boundary.path) return false;
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    return info.isFile() && info.dev === boundary.device && info.ino === boundary.inode && info.size >= boundary.start_offset && await boundaryAnchor(handle, boundary.start_offset) === boundary.anchor_sha256;
  } catch { return false; }
  finally { if (handle) await handle.close().catch(() => {}); }
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
    if (record.turn_capture && !["resolved", "scheduled"].includes(record.turn_capture.state)) return "";
    return readSourceWindow(record.path, MAX_SOURCE_BYTES, turnRefs, record.end_offset, record.source_boundary, record.frozen_window);
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
  identity: SourceWindowIdentity;
  /** Same local read bytes, for exact hashing across a torn UTF-8 suffix. */
  bytes: Buffer;
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
    let start = Math.max(0, end - maxBytes);
    const buffer = Buffer.alloc(Math.min(maxBytes, end));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) return null;
    let bytes = buffer;
    if (start > 0) {
      const newline = bytes.indexOf(10);
      const skip = newline >= 0 ? newline + 1 : bytes.length;
      start += skip;
      bytes = bytes.subarray(skip);
    }
    return { bytes, text: bytes.toString("utf8"), start, end, identity: {start, end, device: info.dev, inode: info.ino, sha256: createHash("sha256").update(bytes).digest("hex")} };
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
  boundary?: SessionSourceBoundary,
  frozenWindow?: SourceWindowIdentity,
): Promise<string | null> {
  // Legacy callers without frozen turn refs get the bounded tail (short files are
  // whole). Production extraction passes turnRefs and still verifies every ref.
  if (!boundary && !frozenWindow && (!turnRefs || turnRefs.length === 0)) return readSourceTail(file, maxBytes);
  let handle: FileHandle | null = null;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (boundary && (file !== boundary.path || info.dev !== boundary.device || info.ino !== boundary.inode || info.size < boundary.start_offset || await boundaryAnchor(handle, boundary.start_offset) !== boundary.anchor_sha256)) return "";
    if (frozenWindow) {
      // Hash the SAME buffer returned to the adapter, never a separate preflight
      // read followed by unchecked mutable bytes. This window starts on a complete
      // pinned root line and has already been bounded before it became a job.
      if (!isSourceWindowIdentity(frozenWindow) || info.dev !== frozenWindow.device || info.ino !== frozenWindow.inode || info.size < frozenWindow.end || endOffset !== frozenWindow.end) return "";
      const bytes = Buffer.alloc(frozenWindow.end - frozenWindow.start);
      const read = await handle.read(bytes, 0, bytes.length, frozenWindow.start);
      if (read.bytesRead !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== frozenWindow.sha256) return "";
      if (boundary && frozenWindow.start < boundary.start_offset) return "";
      const text = bytes.toString("utf8");
      return windowContainsTurnRefs(text, turnRefs ?? []) ? text : "";
    }
    // A frozen boundary is authoritative: read exactly the prefix the completed
    // turn was captured against. If the file shrank below it, the frozen bytes no
    // longer exist — fail honestly instead of silently reading a different tail.
    const frozen = isByteOffset(endOffset);
    if (frozen && info.size < endOffset) return "";
    const end = frozen ? endOffset : info.size;
    if (boundary && end < boundary.start_offset) return "";
    const start = Math.max(boundary?.start_offset ?? 0, end - maxBytes);
    const length = Math.min(maxBytes, end - start);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) return ""; // concurrent truncation: no stable window
    let text = buffer.toString("utf8", 0, bytesRead);
    if (start > 0 && !(boundary && start === boundary.start_offset && boundary.starts_line)) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return windowContainsTurnRefs(text, turnRefs ?? []) ? text : "";
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

/** Parse only bounded metadata, with safe local pointer keys. */
export async function loadSourcePointer(root: string, profile: string, ref: string): Promise<SourcePointerRecord | null> {
  if (!isSafeProfileId(profile) || !isSafeEventRef(ref)) return null;
  try { return JSON.parse(await readFile(pointerPath(root, profile, ref), "utf8")) as SourcePointerRecord; }
  catch { return null; }
}

export async function pendingSourceCaptures(root: string, profile: string): Promise<string[]> {
  if (!isSafeProfileId(profile)) return [];
  const names = await readdir(profileDir(root, profile)).catch(() => []);
  const refs: string[] = [];
  for (const name of names) {
    const ref = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !isSafeEventRef(ref)) continue;
    const record = await loadSourcePointer(root, profile, ref);
    if (record?.turn_capture && ["awaiting", "resolved"].includes(record.turn_capture.state)) refs.push(ref);
  }
  return refs;
}

export function isSourceWindowIdentity(value: unknown): value is SourceWindowIdentity {
  if (!value || typeof value !== "object") return false;
  const r = value as SourceWindowIdentity;
  return isByteOffset(r.start) && isByteOffset(r.end) && r.end >= r.start && r.end - r.start <= MAX_SOURCE_BYTES &&
    isByteOffset(r.device) && isByteOffset(r.inode) && typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256);
}

async function verifyWindow(handle: FileHandle, info: {isFile(): boolean; dev: number; ino: number; size: number}, guard: SourceWindowIdentity): Promise<boolean> {
  if (!isSourceWindowIdentity(guard) || !info.isFile() || info.dev !== guard.device || info.ino !== guard.inode || info.size < guard.end) return false;
  const bytes = Buffer.alloc(guard.end - guard.start);
  const read = await handle.read(bytes, 0, bytes.length, guard.start);
  return read.bytesRead === bytes.length && createHash("sha256").update(bytes).digest("hex") === guard.sha256;
}

/** Resolve from the ORIGINAL start, never from the latest tail. Unchanged observed
 * bytes and inode are mandatory. Later bytes are bounded and not yet extractable.
 */
export async function readObservedSourceWindow(file: string, observed: SourceWindowIdentity): Promise<SourceTailWindow | null> {
  let handle: FileHandle | null = null;
  try {
    if (!isSourceWindowIdentity(observed)) return null;
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!(await verifyWindow(handle, info, observed))) return null;
    const end = Math.min(info.size, observed.start + MAX_SOURCE_BYTES);
    const bytes = Buffer.alloc(end - observed.start);
    const read = await handle.read(bytes, 0, bytes.length, observed.start);
    if (read.bytesRead !== bytes.length || createHash("sha256").update(bytes.subarray(0, observed.end - observed.start)).digest("hex") !== observed.sha256) return null;
    return {bytes, text: bytes.toString("utf8"), start: observed.start, end, identity: {start: observed.start, end, device: info.dev, inode: info.ino, sha256: createHash("sha256").update(bytes).digest("hex")}};
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}
