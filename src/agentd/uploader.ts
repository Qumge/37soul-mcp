/**
 * 上传一批队列项（设计 §4.1 的客户端侧）。
 *
 * 失败分类就是 daemon 的调度指令：
 *   accepted/duplicate → 出队
 *   gap(409)           → 说明有更早的批次没上去：把它压回队列，先补前面的
 *   size_limit(413)    → 把这一项劈成两半重排（服务端说「拆小再发」）
 *   invalid(422)       → 这是客户端 bug（本地 validateBatch 本应拦住），记诊断出队
 *   unauthorized(401)  → token 被吊销：停下这个 Agent 的采集，别刷日志
 *   rate_limited/网络  → 指数退避重试
 */

import type { QueuedUpload } from "./queue.js";
import { splitUpload } from "./queue.js";

export type UploadStatus =
  | "accepted"
  | "duplicate"
  | "gap"
  | "size_limit"
  | "invalid"
  | "unauthorized"
  | "rate_limited"
  | "network";

export interface UploadOutcome {
  status: UploadStatus;
  acceptedTo?: number;
  expectedSeq?: number;
  error?: string;
  split?: QueuedUpload[];
}

export interface UploaderDeps {
  fetch: typeof fetch;
  baseUrl: string;
  tokenFor: (agentKind: string) => string | null;
  log?: { info: (m: string) => void; error: (m: string) => void };
}

export function buildUploadBody(item: QueuedUpload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agent_kind: item.agentKind,
    machine_id: item.machineId,
    session: item.session,
    seq_from: item.seqFrom,
    seq_to: item.seqTo,
    events: item.events,
  };
  if (item.repo && (item.repo.remote || item.repo.branch)) body.repo = item.repo;
  if (item.gitState) body.git_state = item.gitState;
  return body;
}

export async function uploadBatch(deps: UploaderDeps, item: QueuedUpload): Promise<UploadOutcome> {
  const token = deps.tokenFor(item.agentKind);
  if (!token) return { status: "unauthorized", error: `no token configured for ${item.agentKind}` };

  const url = `${deps.baseUrl.replace(/\/$/, "")}/api/v1/me/transcripts`;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // ⚠️ 这个头永远不进日志：logger 只收到 URL 和状态码。
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildUploadBody(item)),
    });
  } catch (error) {
    return { status: "network", error: (error as Error).message };
  }

  let body: any = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  switch (response.status) {
    case 202:
      return { status: "accepted", acceptedTo: body.accepted_to };
    case 200:
      return { status: "duplicate", acceptedTo: body.accepted_to };
    case 409:
      return { status: "gap", expectedSeq: body.expected_seq, acceptedTo: body.accepted_to };
    case 413:
      return { status: "size_limit", error: body.error, split: splitUpload(item) };
    case 422:
      return { status: "invalid", error: body.error ?? "invalid payload" };
    case 401:
      return { status: "unauthorized", error: "token rejected" };
    case 429:
      return { status: "rate_limited", error: body.error ?? "rate limited" };
    default:
      return { status: "network", error: `HTTP ${response.status}` };
  }
}
