#!/usr/bin/env node
/**
 * P0 runtime probe CLI.
 *
 * Usage:
 *   node scripts/probe-runtime.mjs --offline --runtime all
 *   node scripts/probe-runtime.mjs --offline --runtime claude-code
 *
 * Offline mode (the default) exercises the real `createClaudeCodeAdapter` with
 * fake `AdapterDeps` (no host tools, no model, no network, no user HOME writes)
 * and the fake runtime for the remaining kinds, so the probe interface, bounded
 * source scope, structured extraction, local receipt and interrupt evidence can
 * be proven without any live/native verification. `--live` runs the real host
 * conversation and extraction through the same adapter/invoker path; it is opt-in.
 */
import { probeRuntime } from "../dist/adapters/probe.js";
import { createNativeInvoker } from "../dist/agentd/native-invoker.js";
import { createClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { createCodexAdapter, writeCodexHookConfig } from "../dist/adapters/codex.js";
import { codexNativeSessionId } from "../dist/agentd/parsers/codex.js";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeAdapter, RUNTIME_KINDS } from "../test/helpers/fake-runtime.mjs";
import { createOpenCodeAdapter } from "../dist/adapters/opencode.js";
import { writeOpenCodePlugin } from "../dist/adapters/opencode.js";
import { OPENCODE_PLUGIN_SOURCE } from "../dist/adapters/plugins/opencode.js";
import { createHermesAdapter, writeHermesPlugin } from "../dist/adapters/hermes.js";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = { live: false, offline: false, runtimes: ["all"], home: null, work: null, sessionFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--live") args.live = true;
    else if (flag === "--offline") args.offline = true;
    else if (flag === "--runtime") {
      const value = argv[i + 1];
      if (!value) throw new Error("--runtime requires a value: all | claude-code | codex | opencode | hermes");
      args.runtimes = [value];
      i += 1;
    } else if (flag === "--home") {
      const value = argv[i + 1];
      if (!value) throw new Error("--home requires a directory");
      args.home = value;
      i += 1;
    } else if (flag === "--work") {
      const value = argv[i + 1];
      if (!value) throw new Error("--work requires a directory");
      args.work = value;
      i += 1;
    } else if (flag === "--session-file") {
      const value = argv[i + 1];
      if (!value) throw new Error("--session-file requires a path");
      args.sessionFile = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));


const wanted = args.runtimes[0] === "all" ? RUNTIME_KINDS : args.runtimes;
for (const kind of wanted) {
  if (!RUNTIME_KINDS.includes(kind)) {
    console.error(`unknown runtime "${kind}" (expected one of ${RUNTIME_KINDS.join(", ")} or all)`);
    process.exit(2);
  }
}

const report = [];

/** The real Claude Code adapter's offline deps: a minimal completed turn fed
 *  through readSource (the adapter still walks its own turn-resolution) and a
 *  stub model that returns no proposals. Nothing here is a live/native probe. */
function claudeCodeOfflineDeps() {
  const transcript = [
    '{"parentUuid":null,"type":"user","message":{"role":"user","content":"offline probe turn"},"uuid":"turn-offline-u1"}',
    '{"parentUuid":"turn-offline-u1","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"offline probe answer"}]},"uuid":"turn-offline-a1"}',
  ].join("\n");
  return {
    home: "/tmp/37soul-probe-offline",
    readSource: async () => transcript,
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  };
}

/** The real Codex adapter's offline deps: a minimal completed rollout turn fed
 *  through readSource (the adapter still resolves its own completed-turn refs) and
 *  a stub model that returns no proposals. No trust marker exists, so `probe()` and
 *  `inject()` stay honest (all-false / not delivered). Nothing is live/native. */
function codexOfflineDeps() {
  const rollout = [
    '{"timestamp":"2026-10-17T03:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"id":"01a13000-0000-7000-8000-000000000001","cwd":"/tmp/37soul-probe-offline"}}',
    '{"timestamp":"2026-10-17T03:00:00.100Z","ordinal":1,"type":"turn_context","payload":{"turn_id":"turn-1"}}',
    '{"timestamp":"2026-10-17T03:00:01.000Z","ordinal":2,"type":"response_item","payload":{"type":"message","id":"m1","role":"user","content":[{"type":"input_text","text":"offline probe turn"}]}}',
    '{"timestamp":"2026-10-17T03:00:02.000Z","ordinal":3,"type":"response_item","payload":{"type":"message","id":"m2","role":"assistant","content":[{"type":"output_text","text":"offline probe answer"}]}}',
  ].join("\n");
  return {
    home: "/tmp/37soul-probe-offline",
    readSource: async () => rollout,
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  };
}

/** The real OpenCode adapter's offline deps: a minimal completed transcript fed
 *  through readSource (the adapter still resolves its own completed-turn refs) and
 *  a stub model that returns no proposals. No load/trust markers exist, so
 *  `probe()` and `inject()` stay honest (all-false / not delivered). Nothing is
 *  live/native. */
function opencodeOfflineDeps() {
  const transcript = [
    '{"type":"session.created","session_id":"oc-offline-0001","cwd":"/tmp/37soul-probe-offline"}',
    '{"type":"request","id":"req-1","session_id":"oc-offline-0001","prompt":"offline probe turn"}',
    '{"type":"message","id":"m1","session_id":"oc-offline-0001","role":"assistant","content":[{"type":"text","text":"offline probe answer"}]}',
  ].join("\n");
  return {
    home: "/tmp/37soul-probe-offline",
    readSource: async () => transcript,
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  };
}

/** The real Hermes adapter's offline deps: a minimal CLI-shaped turn fed through
 *  readSource (the adapter still resolves its own completed-turn refs) and a stub
 *  model that returns no proposals. No `.hermes` config exists, so `probe()` and
 *  `inject()` stay honest (all-false / not delivered). Nothing is live/native. */
function hermesOfflineDeps() {
  const transcript = [
    '{"type":"session.started","session_id":"h-offline-0001","cwd":"/tmp/37soul-probe-offline"}',
    '{"type":"user_message","id":"u1","session_id":"h-offline-0001","text":"offline probe turn"}',
    '{"type":"assistant_message","id":"a1","session_id":"h-offline-0001","text":"offline probe answer"}',
  ].join("\n");
  return {
    home: "/tmp/37soul-probe-offline",
    readSource: async () => transcript,
    invoke: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    emit: async () => {},
  };
}

const LIVE_PROMPT =
  "这是隔离的 37Soul 验收对话。我的长期偏好是：回答先用一句话给结论，然后列出三条行动项。请简短确认。";

function run(command, argv, options = {}) {
  return spawnSync(command, argv, {
    encoding: "utf8",
    timeout: options.timeout ?? 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: options.env ?? process.env,
    input: options.input,
    cwd: options.cwd,
  });
}

function shellVersion(command) {
  const result = run(command, ["--version"], { timeout: 30000 });
  return (result.stdout || "").trim().split("\n")[0] || null;
}

function newestFile(root, suffix, predicate = () => true) {
  let best = null;
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = path.join(dir, name);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) walk(full);
      else if (name.endsWith(suffix) && predicate(full) && (best === null || info.mtimeMs > best.mtimeMs)) {
        best = { path: full, mtimeMs: info.mtimeMs };
      }
    }
  };
  walk(root);
  return best?.path ?? null;
}

function findClaudeTranscript(sessionId) {
  const projects = path.join(os.homedir(), ".claude", "projects");
  return newestFile(projects, ".jsonl", (file) => path.basename(file, ".jsonl") === sessionId);
}

function ensureAuth(target) {
  if (existsSync(target)) return true;
  try {
    cpSync(path.join(os.homedir(), ".codex", "auth.json"), target);
    chmodSync(target, 0o600);
    return true;
  } catch {
    return false;
  }
}

function launcherWrapper(home) {
  const file = path.join(home, "bin", "37soul");
  mkdirSync(path.dirname(file), { recursive: true });
  const bundle = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "bundle", "cli.js");
  writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(bundle)} "$@"\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function newestTrace(root, subdir) {
  return newestFile(path.join(root, ".37soul", subdir), ".jsonl");
}

async function liveClaude(args, home, work) {
  const version = shellVersion("claude");
  let transcriptPath = args.sessionFile;
  let sessionId = transcriptPath ? path.basename(transcriptPath, ".jsonl") : null;
  let conversation = { status: "provided", session_id: sessionId };
  if (!transcriptPath) {
    sessionId = randomUUID();
    const result = run("claude", [
      "-p", "--output-format", "json", "--tools", "", "--max-turns", "1",
      "--session-id", sessionId, LIVE_PROMPT,
    ], { cwd: work });
    if (result.status !== 0) {
      return { runtime_kind: "claude-code", version, status: "fail", error: "conversation_failed", stderr: (result.stderr || "").slice(0, 2000) };
    }
    transcriptPath = findClaudeTranscript(sessionId);
    conversation = { status: "completed", session_id: sessionId, transcript_path: transcriptPath };
  }
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { runtime_kind: "claude-code", version, status: "fail", error: "transcript_missing", conversation };
  }
  const transcript = readFileSync(transcriptPath, "utf8");
  const adapter = createClaudeCodeAdapter({
    home,
    readSource: async () => transcript,
    invoke: createNativeInvoker({ info: () => {}, error: () => {} }),
    emit: async () => {},
  });
  const result = await adapter.extract({
    job_uid: `live-claude-${Date.now()}`,
    runtime_kind: "claude-code",
    native_session_id: sessionId,
    source_event_refs: ["live-source"],
    binding_uid: "live-binding",
    binding_revision: 1,
    soul_uid: "live-soul",
    internal_task: true,
  });
  const proposals = "proposals" in result ? result.proposals : null;
  return {
    runtime_kind: "claude-code",
    version,
    status: proposals && proposals.length > 0 ? "pass" : "fail",
    conversation,
    transcript_path: transcriptPath,
    proposals,
    error: proposals && proposals.length > 0 ? null : ("error" in result ? result.error : "no_proposals"),
    probe: {
      runtime_kind: "claude-code",
      version,
      session_id: Boolean(sessionId),
      structured_extraction: Boolean(proposals && proposals.length > 0),
      before_request: false,
      internal_marker: false,
      resume: false,
      compact: false,
      interrupt: false,
    },
  };
}

async function liveCodex(args, home, work) {
  const version = shellVersion("codex");
  const codexHome = path.join(home, ".codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  if (!ensureAuth(path.join(codexHome, "auth.json"))) {
    return { runtime_kind: "codex", version, status: "fail", error: "auth_unavailable", codex_home: codexHome };
  }
  const launcher = launcherWrapper(home);
  writeCodexHookConfig(home, { command: launcher });
  const codexEnv = { ...process.env, CODEX_HOME: codexHome, SOUL37_HOME: home, SOUL37_LAUNCHER: launcher };
  const turn = run("codex", ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", "--dangerously-bypass-hook-trust", LIVE_PROMPT], {
    cwd: work,
    env: codexEnv,
  });
  if (turn.status !== 0) {
    return { runtime_kind: "codex", version, status: "fail", error: "conversation_failed", stderr: (turn.stderr || "").slice(0, 2000) };
  }
  const transcriptPath = newestFile(path.join(codexHome, "sessions"), ".jsonl");
  if (!transcriptPath) return { runtime_kind: "codex", version, status: "fail", error: "transcript_missing" };
  const transcript = readFileSync(transcriptPath, "utf8");
  const sessionId = codexNativeSessionId(transcript) ?? path.basename(transcriptPath, ".jsonl");
  const adapter = createCodexAdapter({
    home,
    readSource: async () => transcript,
    invoke: async (runtime, argv, input) => {
      const result = run(runtime, [...argv], { input, env: codexEnv });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    emit: async () => {},
  });
  const result = await adapter.extract({
    job_uid: `live-codex-${Date.now()}`,
    runtime_kind: "codex",
    native_session_id: sessionId,
    source_event_refs: ["live-source"],
    binding_uid: "live-binding",
    binding_revision: 1,
    soul_uid: "live-soul",
    internal_task: true,
  });
  const proposals = "proposals" in result ? result.proposals : null;
  return {
    runtime_kind: "codex",
    version,
    status: proposals && proposals.length > 0 ? "pass" : "fail",
    conversation: { status: "completed", session_id: sessionId, transcript_path: transcriptPath },
    transcript_path: transcriptPath,
    proposals,
    error: proposals && proposals.length > 0 ? null : ("error" in result ? result.error : "no_proposals"),
    hooks: { installed: true, trust: "one-off bypass; not persisted" },
    probe: {
      runtime_kind: "codex",
      version,
      session_id: Boolean(sessionId),
      structured_extraction: Boolean(proposals && proposals.length > 0),
      before_request: false,
      internal_marker: false,
      resume: false,
      compact: false,
      interrupt: false,
    },
  };
}

async function liveOpenCode(args, home, work) {
  const version = shellVersion("opencode");
  const configHome = path.join(home, ".config");
  const cacheHome = path.join(home, ".cache");
  const stateHome = path.join(home, ".state");
  const pluginDir = path.join(configHome, "opencode", "plugins");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "37soul-soul.js"), OPENCODE_PLUGIN_SOURCE, { mode: 0o600 });
  mkdirSync(path.join(configHome, "opencode"), { recursive: true });
  writeFileSync(path.join(configHome, "opencode", "opencode.json"),
    JSON.stringify({ model: "opencode/deepseek-v4.1-flash-free" }, null, 2) + "\n", { mode: 0o600 });
  const launcher = launcherWrapper(home);
  const env = {
    ...process.env,
    SOUL37_HOME: home,
    SOUL37_LAUNCHER: launcher,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
  };
  const turn = run("opencode", ["run", "--standalone", "--format", "json", "-m", "opencode/deepseek-v4.1-flash-free", LIVE_PROMPT], { cwd: work, env });
  if (turn.status !== 0) {
    return { runtime_kind: "opencode", version, status: "fail", error: "conversation_failed", stderr: (turn.stderr || "").slice(0, 2000) };
  }
  const tracePath = newestTrace(home, "opencode-sessions");
  if (!tracePath) return { runtime_kind: "opencode", version, status: "fail", error: "trace_missing" };
  const transcript = readFileSync(tracePath, "utf8");
  const first = transcript.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((line) => line && line.session_id);
  const sessionId = first ? first.session_id : null;
  const adapter = createOpenCodeAdapter({
    home,
    readSource: async () => transcript,
    invoke: async (runtime, argv, input) => {
      const result = run(runtime, [...argv, "-m", "opencode/deepseek-v4.1-flash-free"], { input, env });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    emit: async () => {},
  });
  const result = await adapter.extract({
    job_uid: `live-opencode-${Date.now()}`,
    runtime_kind: "opencode",
    native_session_id: sessionId,
    source_event_refs: ["live-source"],
    binding_uid: "live-binding",
    binding_revision: 1,
    soul_uid: "live-soul",
    internal_task: true,
  });
  const proposals = "proposals" in result ? result.proposals : null;
  return {
    runtime_kind: "opencode", version,
    status: proposals && proposals.length > 0 ? "pass" : "fail",
    conversation: { status: "completed", session_id: sessionId, transcript_path: tracePath },
    proposals,
    error: proposals && proposals.length > 0 ? null : ("error" in result ? result.error : "no_proposals"),
    probe: { runtime_kind: "opencode", version, session_id: Boolean(sessionId), structured_extraction: Boolean(proposals && proposals.length > 0), before_request: false, internal_marker: false, resume: false, compact: false, interrupt: false },
  };
}

async function liveHermes(args, home, work) {
  const version = shellVersion("hermes");
  const hermesHome = path.join(home, ".hermes");
  mkdirSync(hermesHome, { recursive: true });
  for (const name of [".env", "config.yaml", "auth.json"]) {
    const source = path.join(os.homedir(), ".hermes", name);
    if (existsSync(source)) cpSync(source, path.join(hermesHome, name));
  }
  writeHermesPlugin(home);
  const launcher = launcherWrapper(home);
  const env = { ...process.env, HERMES_HOME: hermesHome, SOUL37_HOME: home, SOUL37_LAUNCHER: launcher, HERMES_ACCEPT_HOOKS: "1" };
  const turn = run("hermes", ["chat", "-q", LIVE_PROMPT, "--oneshot", "-Q", "--ignore-rules", "--source", "tool"], { cwd: work, env });
  if (turn.status !== 0) {
    return { runtime_kind: "hermes", version, status: "fail", error: "conversation_failed", stderr: (turn.stderr || "").slice(0, 2000) };
  }
  const tracePath = newestTrace(home, "hermes-sessions");
  if (!tracePath) return { runtime_kind: "hermes", version, status: "fail", error: "trace_missing" };
  const transcript = readFileSync(tracePath, "utf8");
  const first = transcript.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((line) => line && line.session_id);
  const sessionId = first ? first.session_id : null;
  const adapter = createHermesAdapter({
    home,
    readSource: async () => transcript,
    invoke: async (runtime, argv, input) => {
      const result = run(runtime, argv, { input, env });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    emit: async () => {},
  });
  const result = await adapter.extract({
    job_uid: `live-hermes-${Date.now()}`,
    runtime_kind: "hermes",
    native_session_id: sessionId,
    source_event_refs: ["live-source"],
    binding_uid: "live-binding",
    binding_revision: 1,
    soul_uid: "live-soul",
    internal_task: true,
  });
  const proposals = "proposals" in result ? result.proposals : null;
  return {
    runtime_kind: "hermes", version,
    status: proposals && proposals.length > 0 ? "pass" : "fail",
    conversation: { status: "completed", session_id: sessionId, transcript_path: tracePath },
    proposals,
    error: proposals && proposals.length > 0 ? null : ("error" in result ? result.error : "no_proposals"),
    probe: { runtime_kind: "hermes", version, session_id: Boolean(sessionId), structured_extraction: Boolean(proposals && proposals.length > 0), before_request: false, internal_marker: false, resume: false, compact: false, interrupt: false },
  };
}

async function runLive(args) {
  const home = args.home || mkdtempSync(path.join(os.tmpdir(), "37soul-live-"));
  const work = args.work || path.join(home, "work");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true });
  const wanted = args.runtimes[0] === "all" ? ["claude-code", "codex", "opencode", "hermes"] : args.runtimes;
  const results = [];
  for (const runtime of wanted) {
    if (runtime === "claude-code") results.push(await liveClaude(args, home, work));
    else if (runtime === "codex") results.push(await liveCodex(args, home, work));
    else if (runtime === "opencode") results.push(await liveOpenCode(args, home, work));
    else if (runtime === "hermes") results.push(await liveHermes(args, home, work));
    else results.push({ runtime_kind: runtime, status: "not_run", error: "unknown runtime" });
  }
  console.log(JSON.stringify({ live: true, home, work, results }, null, 2));
  return results.every((entry) => entry.status === "pass") ? 0 : 1;
}

if (args.live) {
  const code = await runLive(args);
  process.exit(code);
}
for (const runtime_kind of wanted) {
  const isClaudeCode = runtime_kind === "claude-code";
  const isCodex = runtime_kind === "codex";
  const isOpenCode = runtime_kind === "opencode";
  const isHermes = runtime_kind === "hermes";
  const adapter = isClaudeCode
    ? createClaudeCodeAdapter(claudeCodeOfflineDeps())
    : isCodex
      ? createCodexAdapter(codexOfflineDeps())
      : isOpenCode
        ? createOpenCodeAdapter(opencodeOfflineDeps())
        : isHermes
          ? createHermesAdapter(hermesOfflineDeps())
          : createFakeAdapter(runtime_kind);
  const probe = await probeRuntime(adapter);

  // Prove bounded source scope, structured result and local receipt offline.
  const extraction = await adapter.extract({
    job_uid: `offline-${runtime_kind}-1`,
    runtime_kind,
    native_session_id: "offline-native-session",
    source_event_refs: ["turn-offline-001"],
    binding_uid: "20000000-0000-4000-8000-000000000001",
    binding_revision: 1,
    soul_uid: "10000000-0000-4000-8000-000000000001",
    internal_task: true,
  });
  const bundle = {
    soul_uid: "10000000-0000-4000-8000-000000000001",
    identity_revision: 1,
    binding_uid: "20000000-0000-4000-8000-000000000001",
    binding_revision: 1,
    manifest: [],
    rendered_text: "[Soul]\n",
    truncated: false,
  };
  const injection = await adapter.inject(bundle);

  report.push({
    runtime_kind,
    source: isClaudeCode ? "claude-code-offline" : isCodex ? "codex-offline" : isOpenCode ? "opencode-offline" : isHermes ? "hermes-offline" : "offline-fake",
    version: probe.version,
    supported_version: null, // real supported versions are only registered after authorized live probes pass
    probe,
    extraction: extraction.proposals !== undefined ? { proposals: extraction.proposals } : extraction.error,
    injection,
  });
}

console.log(JSON.stringify({ offline: true, runtimes: report }, null, 2));
