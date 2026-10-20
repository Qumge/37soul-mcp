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
 * be proven without any live/native verification. `--live` stays default-off:
 * real model probes require separate authorization from the executor.
 */
import { probeRuntime } from "../dist/adapters/probe.js";
import { createFakeAdapter, RUNTIME_KINDS } from "../test/helpers/fake-runtime.mjs";
import { createClaudeCodeAdapter } from "../dist/adapters/claude-code.js";

function parseArgs(argv) {
  const args = { live: false, offline: false, runtimes: ["all"] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--live") args.live = true;
    else if (flag === "--offline") args.offline = true;
    else if (flag === "--runtime") {
      const value = argv[i + 1];
      if (!value) throw new Error("--runtime requires a value: all | claude-code | codex | opencode | hermes");
      args.runtimes = [value];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.live) {
  // Live probing must not run in this task: no real adapter exists yet and a real
  // model probe needs authorization from the executor.
  console.error(
    "--live probing is not available yet: real adapters land in Task 6–9 and a " +
      "live model probe requires separate authorization. Re-run with --offline.",
  );
  process.exit(2);
}

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

for (const runtime_kind of wanted) {
  const isClaudeCode = runtime_kind === "claude-code";
  const adapter = isClaudeCode ? createClaudeCodeAdapter(claudeCodeOfflineDeps()) : createFakeAdapter(runtime_kind);
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
    source: isClaudeCode ? "claude-code-offline" : "offline-fake",
    version: probe.version,
    supported_version: null, // real supported versions are only registered after authorized live probes pass
    probe,
    extraction: extraction.proposals !== undefined ? { proposals: extraction.proposals } : extraction.error,
    injection,
  });
}

console.log(JSON.stringify({ offline: true, runtimes: report }, null, 2));
