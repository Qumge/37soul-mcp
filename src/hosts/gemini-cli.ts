import { createGeminiCliAdapter, GEMINI_CLI_EXTRACTION_BLOCKER, latestGeminiCompletedTurnRefs } from "../adapters/gemini-cli.js";
import type { HostHookPayload, HostSpec } from "./types.js";
import { configureNativeHooks, doctorNativeHooks, nativeHookPlan, nativeString, uninstallNativeHooks, type NativeHookConfig } from "./native-json-hooks.js";

const config: NativeHookConfig = {
  kind: "gemini-cli", relativeFile: [".gemini", "settings.json"], grouped: true,
  events: [{ event: "SessionStart", canonical: "SessionStart" }, { event: "BeforeAgent", canonical: "UserPromptSubmit" },
    { event: "AfterAgent", canonical: "Stop" }, { event: "PreCompress", canonical: "PreCompact" }],
  extractionBlocker: GEMINI_CLI_EXTRACTION_BLOCKER,
};

export function parseGeminiPayload(payload: Record<string, any>): HostHookPayload {
  return {
    sessionId: nativeString(payload?.session_id) ?? "unknown",
    cwd: nativeString(payload?.cwd),
    prompt: nativeString(payload?.prompt),
    transcriptPath: nativeString(payload?.transcript_path) ?? null,
  };
}

export const host: HostSpec = {
  kind: "gemini-cli", label: "Gemini CLI", home: ".gemini",
  hook: {
    events: config.events,
    injectionChannel: "UserPromptSubmit",
    emitsRuntimeEvents: true,
    parsePayload: parseGeminiPayload,
    completedTurnRefs: latestGeminiCompletedTurnRefs,
    formatContext: (text, event) => JSON.stringify({ hookSpecificOutput: {
      hookEventName: event === "UserPromptSubmit" ? "BeforeAgent" : "SessionStart", additionalContext: text,
    } }),
  },
  install: {
    plan: ({ home }) => nativeHookPlan(home, config),
    configure: deps => configureNativeHooks(deps, config),
    uninstall: (deps, removed) => uninstallNativeHooks(deps, config, removed),
  },
  doctor: deps => doctorNativeHooks(deps, config),
  invoke: { binary: "gemini", userLaunchers: [".local/bin/gemini", ".npm-global/bin/gemini"], createAdapter: createGeminiCliAdapter },
};
