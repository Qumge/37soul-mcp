/** A native hook can report a transcript before Claude creates it. Keep only
 * that session's path metadata; it is not an extraction source or a binding. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NativeSessionKey } from '../adapters/types.js';

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_HINTS = 128;
interface SessionSourceHint {
  profile_id: string;
  device_id: string;
  runtime_kind: NativeSessionKey['runtime_kind'];
  native_session_id: string;
  path: string;
  captured_at: string;
}
function directory(root: string, key: NativeSessionKey): string {
  return path.join(root, 'session-source-hints', key.profile_id);
}
function safeKey(key: NativeSessionKey): boolean {
  return !!key.profile_id && key.profile_id !== '.' && !/[\\/\0]/.test(key.profile_id) && !key.profile_id.includes('..') &&
    !!key.device_id && !!key.runtime_kind && !!key.native_session_id && key.native_session_id !== 'unknown' && key.native_session_id.length <= 256;
}
function filename(root: string, key: NativeSessionKey): string {
  const id = createHash('sha256').update(JSON.stringify([key.device_id, key.runtime_kind, key.native_session_id])).digest('hex');
  return path.join(directory(root, key), id + '.json');
}

/** Only ENOENT is deferred. Relative paths, directories and access errors are not hints. */
export async function rememberPendingSessionSource(root: string, key: NativeSessionKey, candidate: string): Promise<void> {
  if (!safeKey(key) || !path.isAbsolute(candidate) || candidate.includes('\0')) return;
  try {
    const info = await stat(candidate);
    // This later native event supersedes a pending path in writer order, even
    // when both events receive the same millisecond timestamp.
    if (info.isFile()) await rm(filename(root, key), { force: true });
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
  const dir = directory(root, key);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = filename(root, key), temp = target + '.' + randomUUID() + '.tmp';
  const hint: SessionSourceHint = { profile_id: key.profile_id, device_id: key.device_id, runtime_kind: key.runtime_kind,
    native_session_id: key.native_session_id, path: candidate, captured_at: new Date().toISOString() };
  await writeFile(temp, JSON.stringify(hint) + '\n', { mode: 0o600 });
  await rename(temp, target);
  const rows = [];
  for (const name of await readdir(dir)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const file = path.join(dir, name), info = await stat(file).catch(() => null);
    if (info) rows.push({ file, mtime: info.mtimeMs });
  }
  rows.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  for (let i = 0; i < rows.length; i++) {
    if (i >= MAX_HINTS || Date.now() - rows[i].mtime > MAX_AGE_MS) await rm(rows[i].file, { force: true });
  }
}

/** The connection caller must still open and validate the file at connect time. */
export async function pendingSessionSource(root: string, key: NativeSessionKey): Promise<SessionSourceHint | null> {
  if (!safeKey(key)) return null;
  try {
    const hint = JSON.parse(await readFile(filename(root, key), 'utf8')) as SessionSourceHint;
    if (hint.profile_id !== key.profile_id || hint.device_id !== key.device_id || hint.runtime_kind !== key.runtime_kind ||
        hint.native_session_id !== key.native_session_id || typeof hint.path !== 'string' || !path.isAbsolute(hint.path) || hint.path.includes('\0') ||
        typeof hint.captured_at !== 'string' || !Number.isFinite(Date.parse(hint.captured_at)) || Date.now() - Date.parse(hint.captured_at) > MAX_AGE_MS) return null;
    return hint;
  } catch { return null; }
}
