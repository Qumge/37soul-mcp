/**
 * The single managed Pi extension file.
 *
 * One static, self-contained TypeScript module (node builtins only — Pi loads it
 * through jiti, so no build step and no npm dependency is added) is written into
 * Pi's user extensions directory and recorded in the install manifest by exact
 * path + SHA-256. Install backs it up and replaces only this one entry; uninstall
 * removes only this one entry — another vendor's extension is never touched.
 *
 * Why an extension and not shell hooks: Pi has no shell-hook surface. It has a
 * documented extension API (session_start / before_agent_start / tool_execution_end
 * / agent_settled), which is what this file registers. The bridge performs no model
 * call and schedules nothing itself: it forwards the native lifecycle to the local
 * 37soul writer by invoking `hook --agent pi --event <event>`, so the unified
 * scheduler (not the extension) turns those events into extraction jobs.
 *
 * Injection channel: `hook --event SessionStart` prints
 * `{"hookSpecificOutput":{"additionalContext":"…"}}`; the extension holds that text
 * in memory and appends it to the system prompt of the next run through
 * `before_agent_start`. A bridge failure never fails the user's work: every call is
 * bounded, timeboxed and swallowed.
 *
 * Honesty: the Pi extension surface is documented and locally exercised, but the
 * *extraction* half (native model invocation for structured extraction) is not
 * verified yet — the adapter reports `structured_extraction: false` and install
 * never reports this runtime as trusted/green on the strength of our own file
 * write alone.
 */

/** The Pi extension API generation this bridge targets. Never mixed in one file. */
export const PI_EXTENSION_GENERATION = "pi-extension-v1" as const;

/** The exact file name install writes into Pi's extensions directory (the only entry we own). */
export const PI_EXTENSION_FILENAME = "37soul-soul.ts" as const;

/**
 * The complete, self-contained extension source, installed verbatim.
 * `api_generation` is declared literally so adapters/install can read it back from
 * the installed file. Node builtins only; no runtime dependency is added.
 */
export const PI_EXTENSION_SOURCE = `/**
 * 37soul Pi bridge - ONE managed static file (api_generation pi-extension-v1).
 *
 * Registers the documented Pi extension surface only. Every host call is bounded
 * and timeboxed; a failure here never fails the user's work.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const api_generation = "pi-extension-v1";

const BRIDGE_TIMEOUT_MS = 2500;
const MAX_PROMPT_CHARS = 4096;
const MAX_TOOL_TEXT = 1024;

function launcher() {
  const env = process.env.SOUL37_LAUNCHER;
  if (env && existsSync(env)) return env;
  const local = path.join(os.homedir(), ".local", "bin", "37soul");
  if (existsSync(local)) return local;
  return "37soul";
}

function call(event, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launcher(), ["hook", "--agent", "pi", "--event", event], {
        stdio: ["pipe", "pipe", "ignore"],
        env: process.env,
      });
    } catch {
      resolve("");
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(stdout);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish();
    }, BRIDGE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", finish);
    child.on("close", finish);
    try {
      child.stdin.end(JSON.stringify(payload ?? {}));
    } catch {
      finish();
    }
  });
}

function contextFrom(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const ctx = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
    return typeof ctx === "string" ? ctx.trim() : "";
  } catch {
    return "";
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\\n");
}

function clamp(text, max) {
  const value = typeof text === "string" ? text : "";
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

export default function extension(pi) {
  let sessionId = null;
  let cwd = null;
  let pendingContext = "";

  const sid = (ctx) => {
    try {
      const id = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === "function"
        ? ctx.sessionManager.getSessionId()
        : null;
      return id || sessionId || "unknown";
    } catch {
      return sessionId || "unknown";
    }
  };

  pi.on("session_start", async (event, ctx) => {
    try {
      sessionId = sid(ctx);
      cwd = ctx && typeof ctx.cwd === "string" ? ctx.cwd : null;
      const stdout = await call("SessionStart", {
        session_id: sessionId,
        cwd,
        source: event && typeof event.reason === "string" ? event.reason : "startup",
      });
      pendingContext = contextFrom(stdout);
    } catch {
      pendingContext = "";
    }
  });

  // One handler for the run boundary: deliver the injected Soul context (once per
  // session start) and, for a real user prompt, hand the request boundary to the
  // local writer. Keeping both in one handler avoids two registrations racing.
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      if (event && event.messageType === "user" && typeof event.prompt === "string") {
        const prompt = clamp(event.prompt, MAX_PROMPT_CHARS);
        if (prompt.trim()) {
          await call("UserPromptSubmit", { session_id: sid(ctx), cwd, prompt });
        }
      }
    } catch {}

    if (!pendingContext) return undefined;
    const text = pendingContext;
    pendingContext = ""; // deliver once per session start
    const base = event && typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    return { systemPrompt: base ? base + "\\n\\n" + text : text };
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    try {
      const name = event && (event.toolName || (event.tool && event.tool.name)) || "tool";
      const input = event && (event.input ?? (event.tool && event.tool.input));
      const result = event && (event.result ?? event.output);
      const isError = Boolean(event && (event.isError === true || event.error));
      const outputText = clamp(typeof result === "string" ? result : textOf(result), MAX_TOOL_TEXT);
      await call(isError ? "PostToolUseFailure" : "PostToolUse", {
        session_id: sid(ctx),
        cwd,
        tool_name: String(name),
        tool_input: input === undefined ? undefined : clamp(JSON.stringify(input), MAX_TOOL_TEXT),
        tool_response: outputText,
        is_error: isError,
      });
    } catch {}
  });

  // agent_settled == no automatic continuation remains: the completed-turn signal.
  pi.on("agent_settled", async (event, ctx) => {
    try {
      let last = "";
      try {
        const entries = ctx && ctx.sessionManager && typeof ctx.sessionManager.getEntries === "function"
          ? ctx.sessionManager.getEntries()
          : [];
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const message = entries[i] && entries[i].message;
          if (message && message.role === "assistant") {
            last = clamp(textOf(message.content), MAX_PROMPT_CHARS);
            if (last.trim()) break;
          }
        }
      } catch {}
      await call("Stop", {
        session_id: sid(ctx),
        cwd,
        last_assistant_message: last,
      });
    } catch {}
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await call("SessionEnd", { session_id: sid(ctx), cwd });
    } catch {}
  });
}
`;
