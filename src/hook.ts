/** Native hooks deliver local soul-assets context and source pointers only.
 * Legacy raw spool and remote/cached repository brief injection are retired.
 * Errors stay off stdout and never prevent the host session from starting.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitStateResult } from "./agentd/git-state.js";
import { dataRoot } from "./install.js";
import { loadState } from "./agentd/state.js";
import type { RuntimeEvent, RuntimeEventKind } from "./adapters/types.js";
import type { RuntimeKind } from "./assets/protocol.js";
import { sendWriter } from "./local/writer.js";
import { resolveLocalAssetsProfileSync } from "./local/profiles.js";
import { openStore, StoreError } from "./local/store.js";
import { bindingKey } from "./local/bindings.js";
import { ownerContextInput } from "./sync/client.js";
import { selectContext } from "./assets/context.js";
import { readSourceTailWindow } from "./agentd/source-index.js";
import { hostSpec } from "./hosts/registry.js";
import { parseHookPayload } from "./hosts/shared.js";

export interface HookDeps {
  home: string;
  agentKind: string;
  fetch: typeof fetch;
  stdin: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  getGitState?: (cwd: string) => Promise<GitStateResult>;
  /** 整体预算，默认 300ms（设计 §6.3；内部实现留 50ms 收尾余量）。 */
  timeoutMs?: number;
}

export function wrapAdditionalContext(text: string, eventName: "SessionStart" | "UserPromptSubmit" = "SessionStart"): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
  });
}

/** The old entry point now uses exactly the current assets-only hook path. */
export async function runHook(deps: HookDeps): Promise<number> {
  return runHookCommand({ ...deps, event: "SessionStart" });
}

/** 给整体调用加预算；超时抛错，由调用方保持静默。 */
function withBudget<T>(ms: number, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hook budget of ${ms}ms exceeded`)), ms);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── v2：`37soul hook --agent <kind> --event <事件名>`（设计 §6.3） ─────────────
//
// 除 SessionStart（以及 UserPromptSubmit 通道的首轮注入）外，必须在 50ms 内退出：
// 只解析载荷并提交本地 runtime event/source pointer，不发旧协议请求。

export interface HookCommandDeps extends HookDeps {
  event: string;
  now?: () => number;
}

export async function runHookCommand(deps: HookCommandDeps): Promise<number> {
  try {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(deps.stdin) as Record<string, any>;
    } catch {
      deps.stderr("37soul hook: stdin was not valid JSON\n");
      return 0;
    }

    const root = dataRoot(deps.home);
    // Global pause exits before local runtime events or context injection.
    const state = await loadState(root);
    if (state.paused) return 0;

    const host = hostSpec(deps.agentKind);
    // Unknown kinds get no native capability or legacy fallback.
    const parsed = (host?.hook.parsePayload ?? parseHookPayload)(payload);
    const sessionId = parsed.sessionId;
    // Assets mode (soul-assets/v1): deliver the runtime event to the local writer.
    // SessionStart is awaited: a first-time session has no binding yet, and the
    // writer creates it while handling this event. Injecting concurrently would
    // read the snapshot before that binding commits (first-session race).
    const sourcePath = parsed.transcriptPath;
    let sourceTurnRefs: string[] | undefined;
    let sourceEndOffset: number | undefined;
    if (deps.event === "Stop" && sourcePath) {
      try {
        const window = await readSourceTailWindow(sourcePath);
        if (window !== null) {
          const transcript = window.text;
          sourceTurnRefs = host?.hook.completedTurnRefs?.(transcript);
          if (sourceTurnRefs && sourceTurnRefs.length === 0) sourceTurnRefs = [];
          // Freeze the endpoint this Stop actually read: the drain may run much
          // later, after the transcript has grown past the 4MiB tail window.
          sourceEndOffset = window.end;
        }
      } catch {
        // A missing/unreadable transcript leaves the old event-ref range intact.
      }
    }
    const runtimeEvent = emitRuntimeEvent(
      root, deps.agentKind, deps.event, sessionId, sourcePath, sourceTurnRefs, sourceEndOffset,
    ).catch(() => {});
    // SessionStart needs the binding before injecting. Stop is the completed-turn
    // event whose source pointer must reach the writer before the host exits.
    if (deps.event === "SessionStart" || deps.event === "Stop") await runtimeEvent;
    else void runtimeEvent;

    const channel = host?.hook.injectionChannel ?? "none";
    if (deps.event === "SessionStart" && channel === "SessionStart") {

      // Assets mode (soul-assets/v1): inject the bound Soul's current context instead
      // of the repo brief. Read-only binding lookup + the shared byte-budgeted
      // renderer; the repo brief is never fetched here, and the injected receipt is
      // recorded through the writer only after actual stdout delivery.
      const assets = resolveLocalAssetsProfileSync(root);
      if (assets) {
        await withBudget(deps.timeoutMs ?? 300, () =>
          injectSoulContext(root, deps.home, assets, deps.agentKind, sessionId, deps.stdout, "session", "SessionStart"),
        ).catch(() => {});
        return 0;
      }

      return 0; // Missing/damaged assets metadata never enables old brief injection.
    }

    if (deps.event === "UserPromptSubmit") {
      const assets = resolveLocalAssetsProfileSync(root);
      if (assets) {
        const prompt = parsed.prompt ?? "";
        if (prompt.trim() !== "") {
          await withBudget(deps.timeoutMs ?? 300, () =>
            injectSoulContext(root, deps.home, assets, deps.agentKind, sessionId, deps.stdout, prompt, "UserPromptSubmit"),
          ).catch(() => {});
          return 0;
        }
      }
    }
    return 0; // 其余事件：stdout 必须为空
  } catch (error) {
    deps.stderr(`37soul hook: ${(error as Error).message}\n`);
    return 0;
  }
}

/** hook 事件 → RuntimeEvent 种类（assets 模式才发送）。非四类运行时直接不发。 */
const RUNTIME_EVENT_KINDS: Record<string, RuntimeEventKind> = {
  SessionStart: "resume",
  Stop: "turn_completed",
  PreCompact: "compact",
  UserPromptSubmit: "request",
};

/**
 * Assets-mode runtime-event emission（Task 4）。只在 accounts index 里有
 * `soul_sync_mode === "assets_only"` 的单一本地 profile、且确有 session id 时才发；
 * 事件带 `SOUL37_INTERNAL_JOB_UID`（内部提炼任务标记），writer 用它防递归。
 * 全程 fire-and-forget：writer 不在也不影响会话。
 */
async function emitRuntimeEvent(
  root: string,
  agentKind: string,
  hookEvent: string,
  sessionId: string,
  sourcePath: string | null,
  sourceTurnRefs?: string[],
  sourceEndOffset?: number,
): Promise<void> {
  if (sessionId === "unknown" || !hostSpec(agentKind)?.hook.emitsRuntimeEvents) return;
  const kind = RUNTIME_EVENT_KINDS[hookEvent];
  if (!kind) return;
  const assets = resolveLocalAssetsProfileSync(root);
  if (!assets) return; // No assets profile: remain local and silent, never use legacy protocols.

  const event: RuntimeEvent = {
    key: {
      profile_id: assets.profile_id,
      device_id: assets.device_id,
      runtime_kind: agentKind as RuntimeKind,
      native_session_id: sessionId,
    },
    event_ref: randomUUID(),
    kind,
    ...(sourceTurnRefs !== undefined ? { source_turn_refs: sourceTurnRefs.slice() } : {}),
    internal_job_uid: process.env.SOUL37_INTERNAL_JOB_UID ?? null,
  };
  await sendWriter(root, {
    request_uid: randomUUID(),
    profile_id: assets.profile_id,
    command: "runtime_event",
    // source_path is the host's own transcript location, verbatim and unvalidated
    // here — the writer validates (absolute, existing regular file) before it is
    // ever persisted as a path pointer. Never synthesized for runtimes that omit it.
    payload: {
      event,
      ...(sourcePath !== null ? { source_path: sourcePath } : {}),
      ...(sourceEndOffset !== undefined ? { source_end_offset: sourceEndOffset } : {}),
    },
  });
}

/**
 * Assets-mode Soul-context injection (Task 6). Read-only: the bound native session
 * is looked up from the snapshot (never written here — binding creation stays with
 * the writer/scheduler), the context is rendered by the shared selector, delivered
 * to stdout, and only then is the `injected` receipt recorded through the writer.
 * A missing binding, an empty render, or a missing writer never fails the session.
 *
 * Task 7 trust gate: Codex hooks execute only after the user trusts them, and no
 * authorized live probe has confirmed our hook. A config write WE performed must
 * never make injection green — an untrusted Codex hook skips injection entirely
 * (no stdout, no injected receipt).
 */
async function injectSoulContext(
  root: string,
  home: string,
  assets: { profile_id: string; device_id: string },
  agentKind: string,
  sessionId: string,
  stdout: (text: string) => void,
  taskHint = "session",
  outputEvent: "SessionStart" | "UserPromptSubmit" = "SessionStart",
): Promise<void> {
  const store = await openStore(root, assets.profile_id);
  try {
    const snap = await store.read();
    const key = bindingKey({
      profile_id: assets.profile_id,
      device_id: assets.device_id,
      runtime_kind: agentKind as RuntimeKind,
      native_session_id: sessionId,
    });
    const binding = snap.bindings[key];
    if (!binding || binding.state !== "bound") return;

    let input;
    try {
      input = ownerContextInput(snap, binding.soul_uid, binding, taskHint);
    } catch (error) {
      // Revoked identity/device: never inject a cached private identity. Local
      // originals are handled inside ownerContextInput and remain available.
      if (error instanceof StoreError && error.code === "identity_not_authorized") return;
      throw error;
    }
    const bundle = selectContext(input);
    if (typeof bundle.rendered_text !== "string" || bundle.rendered_text.trim() === "") return;

    // Deliver first, then record the receipt — an injected receipt must only exist
    // after the context actually reached the session.
    stdout(`${wrapAdditionalContext(bundle.rendered_text, outputEvent)}\n`);
    await sendWriter(root, {
      request_uid: randomUUID(),
      profile_id: assets.profile_id,
      command: "record_receipt",
      payload: { binding, bundle, stage: "injected" },
    });
  } finally {
    await store.close();
  }
}
