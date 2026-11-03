import { createCursorAdapter, CURSOR_EXTRACTION_BLOCKER } from "../adapters/cursor.js";
import type { HostHookPayload, HostSpec } from "./types.js";
import { configureNativeHooks, doctorNativeHooks, nativeHookPlan, nativeString, uninstallNativeHooks, type NativeHookConfig } from "./native-json-hooks.js";

const config: NativeHookConfig = {
  kind: "cursor", relativeFile: [".cursor", "hooks.json"], grouped: false,
  events: [{ event: "sessionStart", canonical: "SessionStart" }, { event: "beforeSubmitPrompt", canonical: "UserPromptSubmit" },
    { event: "stop", canonical: "Stop" }, { event: "preCompact", canonical: "PreCompact" }],
  extractionBlocker: CURSOR_EXTRACTION_BLOCKER,
};

export function parseCursorPayload(payload: Record<string, any>): HostHookPayload {
  const conversation = nativeString(payload?.conversation_id);
  // Common schema conversation_id is canonical. session_id is a lifecycle fallback;
  // do not enforce a cross-version equality invariant on native payloads.
  const session = nativeString(payload?.session_id);
  const incomplete = payload?.hook_event_name === "stop" && payload?.status !== "completed";
  const generation = nativeString(payload?.generation_id);
  return {
    // Do not report an aborted/error/malformed stop as a completed runtime turn.
    sessionId: incomplete ? "unknown" : conversation ?? session ?? "unknown",
    cwd: nativeString(payload?.cwd) ?? (Array.isArray(payload?.workspace_roots) ? nativeString(payload.workspace_roots[0]) : undefined),
    prompt: nativeString(payload?.prompt),
    transcriptPath: nativeString(payload?.transcript_path) ?? null,
    ...(payload?.hook_event_name === "stop" && !incomplete && generation ? { sourceTurnRefs: [generation] } : {}),
  };
}

export const host: HostSpec = {
  kind: "cursor", label: "Cursor", home: ".cursor",
  hook: {
    events: config.events,
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseCursorPayload,
    // Cursor transcript IDs/format are not assumed; generation_id comes from the hook.
    formatContext: (text, event) => JSON.stringify(event === "SessionStart" ? { additional_context: text } : {}),
  },
  install: {
    plan: ({ home }) => nativeHookPlan(home, config),
    configure: deps => configureNativeHooks(deps, config),
    uninstall: (deps, removed) => uninstallNativeHooks(deps, config, removed),
  },
  doctor: deps => doctorNativeHooks(deps, config),
  // "agent" belongs to another host on this machine. Never probe or invoke it.
  invoke: { binary: "cursor-agent", userLaunchers: [".local/bin/cursor-agent"], createAdapter: createCursorAdapter },
};
