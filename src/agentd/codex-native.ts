/** Codex host identity and local-only, bound-session transcript observation.
 * No hook, cwd heuristic, latest-session fallback, network, or model call. */
import {constants} from 'node:fs';
import {open, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {BindingSnapshot} from '../adapters/types.js';
import {MAX_SOURCE_BYTES, sourceMatchesBoundary, sourceBoundaryForFile, readObservedSourceWindow, type SourceWindowIdentity} from './source-index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function codexEnvironmentSession(env: NodeJS.ProcessEnv = process.env): string | null {
  return !env.SOUL37_INTERNAL_JOB_UID && UUID.test(env.CODEX_THREAD_ID ?? '') ? env.CODEX_THREAD_ID! : null;
}

export async function verifyCodexRollout(file: string, session: string): Promise<boolean> {
  let handle;
  try {
    if (!path.isAbsolute(file) || !(await lstat(file)).isFile()) return false;
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return false;
    const bytes = Buffer.alloc(256 * 1024);
    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) return false;
    const header = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
    return header.type === 'session_meta' && header.payload?.id === session;
  } catch { return false; } finally { await handle?.close().catch(() => {}); }
}

/** Search names for an exact native ID, then verify the file's own header. */
export async function findCodexRollout(home: string, session: string, codexHome = path.join(home, '.codex')): Promise<string | null> {
  if (!UUID.test(session) || !path.isAbsolute(codexHome)) return null;
  const matches: string[] = []; let visited = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || visited > 50_000 || matches.length > 1) return;
    const entries = await readdir(dir, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (++visited > 50_000 || matches.length > 1) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('-' + session + '.jsonl') && await verifyCodexRollout(file, session)) matches.push(file);
    }
  }
  await walk(path.join(codexHome, 'sessions'), 0);
  return visited <= 50_000 && matches.length === 1 ? matches[0] : null;
}

export interface CodexCursor {offset: number; size: number; turn?: {id: string; start: number; observed: SourceWindowIdentity}; discard_line?: boolean;}
export interface CodexCompletedWindow {ref: string; window: SourceWindowIdentity;}
export interface CodexObservation {cursor: CodexCursor; completed: CodexCompletedWindow[];}

/** Consent resumption/rebind starts at EOF, never backfills previously unauthorized bytes. */
export async function freshCodexBoundary(binding: BindingSnapshot) {
  const old = binding.source_boundary;
  if (!old || !await sourceMatchesBoundary(old.path, old) || !await verifyCodexRollout(old.path, binding.native_session_id)) return null;
  const next = await sourceBoundaryForFile(old.path);
  return next && next.device === old.device && next.inode === old.inode && await sourceMatchesBoundary(old.path, old) ? next : null;
}

/** Read only new bytes. A native task_complete matching task_started is required. */
export async function observeCodexBinding(binding: BindingSnapshot): Promise<CodexObservation | null> {
  const boundary = binding.source_boundary;
  if (!boundary || binding.source_mode !== 'codex-native' || !await sourceMatchesBoundary(boundary.path, boundary)) return null;
  let handle;
  try {
    handle = await open(boundary.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== boundary.device || info.ino !== boundary.inode) return null;
    const previous = binding.codex_cursor ?? {offset: boundary.start_offset, size: boundary.start_offset, discard_line: !boundary.starts_line};
    if (info.size < previous.offset) return null;
    if (info.size === previous.size) return {cursor: previous, completed: []};
    const cursor: CodexCursor = {...previous, turn: previous.turn ? {...previous.turn} : undefined, size: info.size};
    let streamStart = previous.offset, streamBytes: Buffer;
    if (previous.turn && previous.offset - previous.turn.start < MAX_SOURCE_BYTES) {
      const observed = previous.turn.observed;
      if (!observed || observed.start !== previous.turn.start || observed.end !== previous.offset) return null;
      const window = await readObservedSourceWindow(boundary.path, observed);
      if (!window || window.identity.device !== info.dev || window.identity.inode !== info.ino) return null;
      streamStart = window.start; streamBytes = window.bytes;
    } else {
      cursor.turn = undefined;
      streamBytes = Buffer.alloc(Math.min(MAX_SOURCE_BYTES, info.size - cursor.offset));
      if ((await handle.read(streamBytes, 0, streamBytes.length, cursor.offset)).bytesRead !== streamBytes.length) return null;
    }
    const bytes = streamBytes.subarray(previous.offset - streamStart);
    const completed: CodexCompletedWindow[] = [];
    let position = 0;
    while (position < bytes.length) {
      const newline = bytes.indexOf(10, position);
      if (newline < 0) {
        if (bytes.length === MAX_SOURCE_BYTES && position === 0) { cursor.turn = undefined; cursor.discard_line = true; cursor.offset += bytes.length; }
        break;
      }
      const start = previous.offset + position, end = previous.offset + newline + 1;
      const line = bytes.subarray(position, newline).toString('utf8'); position = newline + 1; cursor.offset = end;
      if (cursor.discard_line) { cursor.discard_line = false; continue; }
      let record; try {record = JSON.parse(line);} catch {cursor.turn = undefined; continue;}
      const p = record?.payload;
      if (record.type === 'compacted') { cursor.turn = undefined; continue; }
      if (record.type !== 'event_msg') continue;
      if (p?.type === 'task_started' && typeof p.turn_id === 'string' && UUID.test(p.turn_id)) cursor.turn = {id: p.turn_id, start, observed: {start, end, device: info.dev, inode: info.ino, sha256: createHash("sha256").update(bytes.subarray(position - (end - start), position)).digest("hex")}};
      else if (['task_aborted', 'turn_aborted', 'task_interrupted'].includes(p?.type)) cursor.turn = undefined;
      else if (p?.type === 'task_complete') {
        const turn = cursor.turn; cursor.turn = undefined;
        if (!turn || p.turn_id !== turn.id || end - turn.start > MAX_SOURCE_BYTES) continue;
        if (turn.start < streamStart || end > streamStart + streamBytes.length) continue;
        const windowBytes = streamBytes.subarray(turn.start - streamStart, end - streamStart);
        completed.push({ref: 'codex-turn:' + turn.id, window: {start: turn.start, end, device: info.dev, inode: info.ino, sha256: createHash('sha256').update(windowBytes).digest('hex')}});
      }
    }
    if (cursor.turn) {
      const turnBytes = streamBytes.subarray(cursor.turn.start - streamStart, cursor.offset - streamStart);
      if (cursor.offset - cursor.turn.start >= MAX_SOURCE_BYTES) cursor.turn = undefined;
      else cursor.turn.observed = {start: cursor.turn.start, end: cursor.offset, device: info.dev, inode: info.ino, sha256: createHash("sha256").update(turnBytes).digest("hex")};
    }
    // A bounded pass may leave unread bytes; the next pass must not treat them as unchanged.
    if (previous.offset + bytes.length < info.size || (cursor.offset < info.size && position === bytes.length)) cursor.size = cursor.offset;
    return {cursor, completed};
  } catch {return null;} finally {await handle?.close().catch(() => {});}
}
