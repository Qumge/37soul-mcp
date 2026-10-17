/**
 * 用户全局配置的窄编辑器（设计 §6.1）。
 *
 * 三条铁律：
 *   1. 写之前先备份（`*.37soul.bak`，只备一次 —— 别把用户后来的改动覆盖掉）；
 *   2. 只动我们标记的片段 / 我们自己的键，其余原样保留（JSON 重新序列化会动
 *      格式，所以非我们的文件只在必要时才写）；
 *   3. 现有文件损坏（JSON 解析失败）→ **在动任何字节之前**报错退出。
 */

import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const BEGIN_MARKER = "<!-- 37soul:begin -->";
export const END_MARKER = "<!-- 37soul:end -->";

export interface EditResult {
  changed: boolean;
  backup?: string;
}

export async function backupOnce(file: string): Promise<string | undefined> {
  try {
    await stat(file);
  } catch {
    return undefined; // 还没这个文件，没什么可备
  }
  const backup = `${file}.37soul.bak`;
  try {
    await stat(backup);
    return backup; // 已经备过 —— 别覆盖
  } catch {
    await copyFile(file, backup);
    return backup;
  }
}

async function readTextOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** 读 JSON；文件损坏时抛错，绝不带着半解析状态往下走。 */
export async function readJsonFile<T = Record<string, unknown>>(file: string): Promise<T> {
  const text = await readTextOrEmpty(file);
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`existing config is not valid JSON: ${file} (${(error as Error).message})`);
  }
}

export async function writeJsonFile(file: string, value: unknown, mode = 0o600): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, file);
}

/** 对 JSON 文件做一次 mutate；mutate 返回 false 表示「不用写」。 */
export async function editJsonFile(
  file: string,
  mutate: (document: Record<string, any>) => boolean | void,
  opts: { backup?: boolean; mode?: number } = {},
): Promise<EditResult> {
  const document = await readJsonFile<Record<string, any>>(file);
  const shouldWrite = mutate(document);
  if (shouldWrite === false) return { changed: false };

  const backup = opts.backup === false ? undefined : await backupOnce(file);
  await writeJsonFile(file, document, opts.mode ?? 0o600);
  return { changed: true, backup };
}

/**
 * 管理带标记的 Markdown/文本片段：有标记就替换标记之间的内容，没有就追加。
 * 文件不存在时创建。
 */
export async function editManagedFragment(
  file: string,
  fragment: string,
  opts: { backup?: boolean } = {},
): Promise<EditResult> {
  const existing = await readTextOrEmpty(file);
  const managed = `${BEGIN_MARKER}\n${fragment.trimEnd()}\n${END_MARKER}`;
  let updated: string;

  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin >= 0 && end > begin) {
    updated = `${existing.slice(0, begin)}${managed}${existing.slice(end + END_MARKER.length)}`;
  } else {
    const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    updated = `${existing}${separator}${managed}\n`;
  }

  if (updated === existing) return { changed: false };
  const backup = opts.backup === false || existing === "" ? undefined : await backupOnce(file);
  await writeFile(file, updated, { mode: 0o644 });
  return { changed: true, backup };
}

/** 卸载：只拿掉标记片段；标记外的内容（包括用户自己的行）一个字节都不动。 */
export async function removeManagedFragment(file: string): Promise<EditResult> {
  const existing = await readTextOrEmpty(file);
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin < 0 || end <= begin) return { changed: false };

  let updated = `${existing.slice(0, begin)}${existing.slice(end + END_MARKER.length)}`;
  updated = updated.replace(/\n{3,}/g, "\n\n");
  const backup = await backupOnce(file);
  await writeFile(file, updated, { mode: 0o644 });
  return { changed: true, backup };
}

export function hasManagedFragment(text: string): boolean {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  return begin >= 0 && end > begin;
}

export function agentDataRoot(home: string): string {
  return path.join(home, ".37soul");
}
