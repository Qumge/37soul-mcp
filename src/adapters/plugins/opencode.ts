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
 * 37soul OpenCode bridge - ONE managed static file (api_generation v2).
 * The host API is the documented OpenCode plugin surface: a named async plugin
 * function returning lifecycle hooks. The bridge only talks to the local 37soul
 * hook command; it performs no model call and no network call.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const api_generation = "v2";
const MAX_BRIDGE_PAYLOAD_BYTES = 8192;
const BRIDGE_TIMEOUT_MS = 2000;
const SESSION_DIR = ".37soul";
const soulHome = process.env.SOUL37_HOME || os.homedir();

export function boundedPayload(event, payload) {
  const bounded = { ...(payload ?? {}) };
  for (const key of Object.keys(bounded)) {
    if (typeof bounded[key] === "string") bounded[key] = bounded[key].slice(0, 1024);
  }
  const json = JSON.stringify({ ...bounded, agent: "opencode", event });
  if (Buffer.byteLength(json, "utf8") > MAX_BRIDGE_PAYLOAD_BYTES) {
    return JSON.stringify({ agent: "opencode", event, payload: null, truncated: true });
  }
  return json;
}

function launcher() {
  const env = process.env.SOUL37_LAUNCHER;
  if (env && existsSync(env)) return env;
  const local = path.join(os.homedir(), ".local", "bin", "37soul");
  if (existsSync(local)) return local;
  return "37soul";
}

function bridge(event, payload) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(launcher(), ["hook", "--agent", "opencode", "--event", event], {
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
      child.stdin.end(boundedPayload(event, payload));
    } catch {
      finish();
    }
  });
}

function bridgeSync(event, payload) {
  try {
    spawnSync(launcher(), ["hook", "--agent", "opencode", "--event", event], {
      input: boundedPayload(event, payload),
      encoding: "utf8",
      timeout: BRIDGE_TIMEOUT_MS,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env,
    });
  } catch {}
}

function tracePath(sessionID) {
  const safe = String(sessionID).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(soulHome, SESSION_DIR, "opencode-sessions", safe + ".jsonl");
}

function ensureTrace(sessionID) {
  const file = tracePath(sessionID);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  return file;
}

function appendTrace(sessionID, record) {
  const file = ensureTrace(sessionID);
  appendFileSync(file, JSON.stringify(record) + "\\n", { mode: 0o600 });
  return file;
}

function textOfParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\\n");
}

function traceFromMessages(sessionID, rows) {
  const records = [];
  for (const row of rows) {
    const info = row && (row.info && typeof row.info === "object" ? row.info : row);
    if (!info || typeof info !== "object") continue;
    const parts = Array.isArray(row.parts)
      ? row.parts
      : Array.isArray(info.content)
        ? info.content
        : [];
    const text = textOfParts(parts);
    if (info.role === "user" && text.trim() !== "") {
      records.push({ type: "request", id: info.id, session_id: sessionID, prompt: text });
    } else if (info.role === "assistant" && text.trim() !== "") {
      records.push({ type: "message", id: info.id, session_id: sessionID, role: "assistant", content: text });
    }
    for (const part of parts) {
      if (!part || part.type !== "tool") continue;
      records.push({
        type: "tool",
        id: part.id,
        session_id: sessionID,
        name: part.tool || part.type,
        input: part.state && part.state.input,
        output: part.state && part.state.output,
      });
    }
  }
  return records;
}

async function syncTrace(ctx, sessionID) {
  const file = ensureTrace(sessionID);
  try {
    const result = await ctx.client.session.messages({ path: { id: sessionID } });
    const rows = Array.isArray(result) ? result : Array.isArray(result && result.data) ? result.data : [];
    const records = traceFromMessages(sessionID, rows);
    if (records.length > 0) writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n", { mode: 0o600 });
    const lastAssistant = [...records].reverse().find((record) => record.type === "message");
    return { file, lastAssistant: lastAssistant ? lastAssistant.content : "" };
  } catch {
    return { file, lastAssistant: "" };
  }
}

function contextFromHook(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === "string"
      ? parsed.hookSpecificOutput.additionalContext.trim()
      : "";
  } catch {
    return "";
  }
}

function writeTraceFromMessages(sessionID, rows) {
  const file = ensureTrace(sessionID);
  const records = traceFromMessages(sessionID, rows);
  if (records.length > 0) {
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n", { mode: 0o600 });
  }
  const lastAssistant = [...records].reverse().find((record) => record.type === "message");
  return { file, lastAssistant: lastAssistant ? lastAssistant.content : "" };
}

export default {
  id: "37soul",
  async setup(ctx) {
    const directory = ctx && ctx.location && typeof ctx.location.directory === "string"
      ? ctx.location.directory
      : process.cwd();
    const traces = new Map();
    const assistantText = new Map();
    const controller = new AbortController();

    function fileFor(sessionID) {
      if (!traces.has(sessionID)) traces.set(sessionID, ensureTrace(sessionID));
      return traces.get(sessionID);
    }

    await ctx.session.hook("context", async (event) => {
      try {
        const sid = event && event.sessionID;
        if (!sid) return;
        const file = fileFor(sid);
        if (Array.isArray(event.messages)) writeTraceFromMessages(sid, event.messages);
        const stdout = await bridge("SessionStart", {
          session_id: sid,
          cwd: directory,
          source: "startup",
          transcript_path: file,
        });
        const context = contextFromHook(stdout);
        if (context && Array.isArray(event.system)) event.system.push({ type: "text", text: context });

        // Before the model call, use the real user task as the selector hint for
        // relevant experience assets; SessionStart above keeps identity/relationship.
        const lastUser = [...(Array.isArray(event.messages) ? event.messages : [])]
          .reverse()
          .find((row) => row && (row.role || (row.info && row.info.role)) === "user");
        const userParts = lastUser && Array.isArray(lastUser.parts)
          ? lastUser.parts
          : lastUser && Array.isArray(lastUser.content)
            ? lastUser.content
            : [];
        const taskText = textOfParts(userParts);
        if (taskText !== "") {
          const promptStdout = await bridge("UserPromptSubmit", {
            session_id: sid,
            cwd: directory,
            prompt: taskText,
            transcript_path: file,
          });
          const promptContext = contextFromHook(promptStdout);
          if (promptContext && Array.isArray(event.system) && promptContext !== context) {
            event.system.push({ type: "text", text: promptContext });
          }
        }
      } catch {}
    });

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const data = event.data || {};
          const sid = data.sessionID;
          if (!sid) continue;
          if (event.type === "session.text.delta" && typeof data.delta === "string") {
            assistantText.set(sid, (assistantText.get(sid) || "") + data.delta);
            continue;
          }
          if (event.type === "session.text.ended" && typeof data.text === "string") {
            assistantText.set(sid, data.text);
            continue;
          }
          if (event.type !== "session.execution.succeeded") continue;
          try {
            const file = fileFor(sid);
            const text = assistantText.get(sid) || "";
            if (text !== "") {
              appendTrace(sid, {
                type: "message",
                id: data.assistantMessageID || "assistant-" + event.id,
                session_id: sid,
                role: "assistant",
                content: text,
              });
            }
            // This runs while the host is finalizing the turn. Awaiting an
            // asynchronous child can lose the event at CLI shutdown; use the
            // bounded synchronous bridge so the local writer definitely sees Stop.
            bridgeSync("Stop", {
              session_id: sid,
              cwd: directory,
              transcript_path: file,
              last_assistant_message: text,
            });
          } catch {}
        }
      } catch {}
    })();

    return () => controller.abort();
  },
};
`;
