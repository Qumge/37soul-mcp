import { createKiroAdapter } from "../adapters/kiro.js";
import type { HostHookPayload, HostSpec } from "./types.js";
import { nativeString } from "./native-json-hooks.js";
import { configureKiroHooks, doctorKiroHooks, kiroHookPlan, KIRO_HOOK_EVENTS, uninstallKiroHooks } from "./kiro-hooks.js";

export function parseKiroPayload(payload: Record<string, any>): HostHookPayload {
  return {
    sessionId: nativeString(payload?.session_id) ?? "unknown",
    cwd: nativeString(payload?.cwd),
    // Kiro sends the prompt in the hook event body; older surfaces exposed it
    // as USER_PROMPT. Identity and context never depend on guessing a prompt.
    prompt: nativeString(payload?.prompt) ?? nativeString(payload?.user_prompt) ?? nativeString(payload?.USER_PROMPT),
    // Kiro's hook payload does not document a transcript location. Never guess
    // one from cwd and never turn a host path into an extraction source.
    transcriptPath: null,
  };
}

export const host: HostSpec = {
  kind: "kiro", label: "Kiro", home: ".kiro",
  hook: {
    events: KIRO_HOOK_EVENTS,
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseKiroPayload,
    // Kiro CLI adds command stdout to the session context as plain text.
    formatContext: text => text,
  },
  install: {
    plan: ({ home }) => kiroHookPlan(home),
    configure: deps => configureKiroHooks(deps),
    uninstall: (deps, removed) => uninstallKiroHooks(deps, removed),
  },
  doctor: deps => doctorKiroHooks(deps),
  invoke: { binary: "kiro-cli", userLaunchers: [".local/bin/kiro-cli", ".kiro/bin/kiro-cli"], createAdapter: createKiroAdapter },
};
