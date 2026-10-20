/**
 * Task 8: the single managed OpenCode bridge file.
 *
 * One static, self-contained ESM file (node builtins only — no Python/Node package
 * install) is written into the user's OpenCode plugin directory and recorded in the
 * install manifest by exact path + SHA-256. Install backs it up and replaces only
 * this one entry; uninstall removes only this one entry — another vendor's plugin
 * file is never touched.
 *
 * The bridge performs no model call and schedules nothing itself: it only forwards
 * the native session/request/message lifecycle to the local 37soul writer by
 * invoking `hook --agent opencode --event <event>`, so the unified scheduler (not
 * the plugin) turns those events into extraction jobs. A bridge failure never fails
 * the user's work.
 *
 * The whole plugin API shape is UNVERIFIED: no authorized live probe has confirmed
 * it against a real OpenCode host (the plan records that OpenCode's version command
 * failed on the user's machine). It exists as explicit data so the adapter can
 * declare the generation it ships and install/doctor can detect an unsupported or
 * mixed generation without guessing.
 */

/** The plugin API generation this bridge implements. Never mixed with V1 in one config. */
export const OPENCODE_PLUGIN_GENERATION = "v2" as const;

/** The exact file name install writes into the plugin directory (the only entry we own). */
export const OPENCODE_PLUGIN_FILENAME = "37soul-soul.js" as const;

/**
 * The complete, self-contained plugin source, installed verbatim. `api_generation`
 * is declared literally so the adapter's generation parser can read it back from the
 * installed file. Node builtins only; no runtime dependency is added.
 */
export const OPENCODE_PLUGIN_SOURCE = `/**
 * 37soul OpenCode bridge — ONE managed static file (api_generation v2).
 * UNVERIFIED against a live OpenCode host: the plugin API shape below is modeled,
 * not confirmed by an authorized live probe. It performs no model call and
 * schedules nothing — it forwards the native session/request/message lifecycle to
 * the local 37soul writer via \`hook --agent opencode --event <event>\`. A bridge
 * failure never fails the user's work.
 */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function launcher() {
  const env = process.env.SOUL37_LAUNCHER;
  if (env && existsSync(env)) return env;
  const local = path.join(os.homedir(), ".local", "bin", "37soul");
  if (existsSync(local)) return local;
  return "37soul";
}

// The bridge spawns exactly ONE command: the installed 37soul launcher's local
// \`hook --agent opencode --event <event>\` — fixed argv array (no shell), never the
// host runtime, never a network call. The payload is bounded and fed on stdin; a
// short timeout bounds the wait; exit code 0 is the only success signal we rely on.
const MAX_BRIDGE_PAYLOAD_BYTES = 8192;
const BRIDGE_TIMEOUT_MS = 2000;

function boundedPayload(payload) {
  const bounded = { ...(payload ?? {}) };
  for (const key of Object.keys(bounded)) {
    if (typeof bounded[key] === "string") bounded[key] = bounded[key].slice(0, 1024);
  }
  let json = JSON.stringify(bounded);
  if (Buffer.byteLength(json, "utf8") > MAX_BRIDGE_PAYLOAD_BYTES) {
    json = json.slice(0, MAX_BRIDGE_PAYLOAD_BYTES);
  }
  return json;
}

function bridge(event, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launcher(), ["hook", "--agent", "opencode", "--event", event], {
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish();
    }, BRIDGE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", finish);
    child.on("close", finish);
    try {
      child.stdin.end(boundedPayload(payload));
    } catch {
      finish();
    }
  });
}

function sessionId(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of ["session_id", "sessionID", "sessionId"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export default {
  api_generation: "v2",

  // V2 surface (modeled, UNVERIFIED): a single onEvent hook named by lifecycle.
  async onEvent(input) {
    const sid = sessionId(input);
    if (!sid) return {};
    try {
      const event = input && input.event;
      switch (event) {
        case "session.created":
        case "session.reset":
          await bridge("SessionStart", {
            session_id: sid,
            cwd: input.cwd,
            source: event === "session.reset" ? "reset" : "startup",
          });
          break;
        case "request.started":
          await bridge("UserPromptSubmit", { session_id: sid, prompt: input.prompt ?? "" });
          break;
        case "message.completed":
          await bridge("Stop", { session_id: sid, last_assistant_message: input.message ?? "" });
          break;
        default:
          break;
      }
    } catch {
      // A bridge failure never fails the user's work.
    }
    return {};
  },
};
`;
