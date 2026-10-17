/**
 * agentd 的本地持久状态（设计 §6.2）。
 *
 * 状态写坏了 = 重复上传或丢事件。所以：
 *   · 原子写（临时文件 + rename），进程崩溃不会留下半个 JSON；
 *   · 文件 mode 0600（里面有上传进度，也间接暴露这台机器在干什么）；
 *   · 读坏了就当作空状态（再采集一遍是幂等的：服务端按 seq 去重）。
 */

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import type { FileCursor } from "./types.js";

export const STATE_VERSION = 1;

export interface SessionState {
  cursor?: FileCursor;
  /** 最近一次成功上传的时间（ISO），doctor 用。 */
  last_upload_at?: string;
  last_uploaded_seq?: number;
  last_error?: string;
}

export interface DaemonState {
  version: number;
  machine_id: string;
  sessions: Record<string, SessionState>;
  paused?: boolean;
  paused_repos?: string[];
}

export function defaultRoot(): string {
  return path.join(os.homedir(), ".37soul");
}

export function statePath(root: string): string {
  return path.join(root, "state.json");
}

export function emptyState(machineId: string = randomUUID()): DaemonState {
  return { version: STATE_VERSION, machine_id: machineId, sessions: {} };
}

export async function loadState(root: string): Promise<DaemonState> {
  try {
    const raw = await readFile(statePath(root), "utf8");
    const parsed = JSON.parse(raw) as DaemonState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.machine_id !== "string" || parsed.machine_id === "") {
      return emptyState();
    }
    return {
      version: STATE_VERSION,
      machine_id: parsed.machine_id,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      paused: parsed.paused === true,
      paused_repos: Array.isArray(parsed.paused_repos) ? parsed.paused_repos.filter((r) => typeof r === "string") : [],
    };
  } catch {
    return emptyState();
  }
}

export async function saveState(root: string, state: DaemonState): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = statePath(root);
  const temp = `${target}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
  try {
    await chmod(target, 0o600);
  } catch {
    // 平台不支持时忽略；写权限本身已经由 mkdir 0700 收着。
  }
}
