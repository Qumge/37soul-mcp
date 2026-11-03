import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOSTS, hostSpec, SUPPORTED_AGENTS, AGENT_HOMES } from "../dist/hosts/registry.js";
import { RUNTIME_KINDS } from "../dist/assets/protocol.js";
import { detectAgents, planInstall } from "../dist/install.js";
import { createExtractAdapters } from "../dist/agentd/native-invoker.js";

const LEGACY_KINDS = ["claude-code", "codex", "opencode", "hermes", "pi"];
const KINDS = [...LEGACY_KINDS, "gemini-cli", "cursor"];

test("hosts: registry covers the protocol in order with unique homes and complete dispatch", () => {
  assert.deepEqual(HOSTS.map((host) => host.kind), KINDS);
  assert.deepEqual(HOSTS.map((host) => host.kind), RUNTIME_KINDS);
  assert.deepEqual(SUPPORTED_AGENTS, RUNTIME_KINDS);
  assert.equal(new Set(HOSTS.map((host) => host.home)).size, 7);
  assert.deepEqual(Object.values(AGENT_HOMES), [".claude", ".codex", ".config/opencode", ".hermes", ".pi", ".gemini", ".cursor"]);
  for (const host of HOSTS) {
    assert.equal(hostSpec(host.kind), host);
    for (const method of ["plan", "configure", "uninstall"]) assert.equal(typeof host.install[method], "function");
    assert.equal(typeof host.hook.parsePayload, "function");
    assert.equal(typeof host.doctor, "function");
  }
  assert.equal(hostSpec("gemini-cli").kind, "gemini-cli");
  assert.equal(hostSpec("unknown"), undefined);
});

test("hosts: detection keeps Gemini visible and plan preserves the existing file order", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "37soul-hosts-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".gemini"));
  assert.deepEqual(await detectAgents(home), ["gemini-cli"]);
  for (const dir of [".claude", ".codex", ".config/opencode", ".hermes", ".pi", ".cursor"]) {
    await mkdir(path.join(home, dir), { recursive: true });
  }
  assert.deepEqual(await detectAgents(home), KINDS);
  const deps = { home, cliScriptPath: "/pkg/dist/cli.js", runtimeVersion: "0.13.2", platform: "darwin" };
  const plan = await planInstall(deps);
  const hostFiles = [
    [".claude/settings.json", ".claude/CLAUDE.md"],
    [".codex/AGENTS.md", ".codex/hooks.json"],
    [".config/opencode/plugins/37soul-soul.js"],
    [".hermes/agent-hooks/37soul-hook.py"],
    [".pi/agent/extensions/37soul-soul.ts"],
    [".gemini/settings.json"],
    [".cursor/hooks.json"],
  ];
  const commonFiles = [".37soul/config.json", ".37soul/install-manifest.json", ".37soul/runtime/0.13.2", ".local/bin/37soul"];
  const absolute = (files) => files.map((file) => path.join(home, file));
  assert.deepEqual(plan.agents, KINDS);
  assert.deepEqual(plan.unsupported, []);
  assert.deepEqual(plan.files, absolute([...hostFiles.flat(), ...commonFiles]));
  for (const [index, kind] of KINDS.entries()) {
    assert.deepEqual((await planInstall(deps, { agents: [kind] })).files, absolute([...hostFiles[index], ...commonFiles]));
  }
  assert.deepEqual((await planInstall(deps, { agents: [...KINDS].reverse() })).files, plan.files);
});

test("hosts: extraction constructs all seven registered adapters", () => {
  const adapters = createExtractAdapters("/unused-host-registry-home");
  assert.deepEqual(Object.keys(adapters), KINDS);
  for (const kind of KINDS) assert.equal(adapters[kind].runtime_kind, kind);
});

test("hosts: Claude completed-turn parser preserves fixture refs", async () => {
  const transcript = await readFile(new URL("./fixtures/runtimes/claude-code/stop-turn.jsonl", import.meta.url), "utf8");
  assert.deepEqual(hostSpec("claude-code").hook.completedTurnRefs(transcript), ["c-u6", "c-a5"]);
});

// Consumer contracts: metadata alone is insufficient; entry points must dispatch
// through the registry. Each override is restored before the next test.
test("hosts: planInstall delegates selected file plans in registry order", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "37soul-plan-dispatch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const host = hostSpec("pi");
  const original = host.install.plan;
  t.after(() => { host.install.plan = original; });
  host.install.plan = ({ home }) => [path.join(home, "registry-plan")];
  const result = await planInstall({ home, cliScriptPath: "/pkg/dist/cli.js", runtimeVersion: "0.13.2", platform: "darwin" }, { agents: ["pi"] });
  assert.equal(result.files[0], path.join(home, "registry-plan"));
});

test("hosts: extraction uses registered adapter factories", () => {
  const host = hostSpec("pi");
  const original = host.invoke.createAdapter;
  const expected = { runtime_kind: "pi", fromRegistry: true };
  try {
    host.invoke.createAdapter = () => expected;
    assert.equal(createExtractAdapters("/unused-host-registry-home").pi, expected);
  } finally {
    host.invoke.createAdapter = original;
  }
});

test("hosts: hook consumes the registered payload parser", async (t) => {
  const { runHookCommand } = await import("../dist/hook.js");
  const { openStore } = await import("../dist/local/store.js");
  const { startWriter } = await import("../dist/local/writer.js");
  const { writeFile, readdir } = await import("node:fs/promises");
  await import("../dist/extraction/scheduler.js");
  const home = await mkdtemp(path.join(tmpdir(), "37soul-hook-dispatch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".37soul");
  const profileId = "registry-profile";
  const deviceId = "registry-device";
  await mkdir(path.join(root, "profiles", profileId), { recursive: true });
  await writeFile(path.join(root, "profiles", profileId, "device.json"), JSON.stringify({ device_id: deviceId }));
  await writeFile(path.join(root, "accounts.json"), JSON.stringify({ anonymous: { profile_id: profileId, default_soul_uid: "s1", soul_sync_mode: "assets_only" } }));
  await writeFile(path.join(root, "config.json"), JSON.stringify({ api_base_url: "https://fake.test", machine_id: "fake-machine", tokens: {}, active_profile_id: profileId }));
  const store = await openStore(root, profileId);
  try {
    await store.transact(draft => {
      draft.souls.s1 = {
        soul_uid: "s1", legacy_host_id: null, identity_revision: 1, state: "active",
        identity: { name: "Registry Soul", description: "", character: "", greeting: "" },
      };
    });
  } finally { await store.close(); }
  // Distinct real source files make bypassing the registry parser observable in
  // the writer's persisted pointer as well as in the newly created binding.
  const registryTranscript = path.join(home, "registry-session.jsonl");
  const rawTranscript = path.join(home, "raw-session.jsonl");
  await writeFile(registryTranscript, "{}\n");
  await writeFile(rawTranscript, "{}\n");
  const host = hostSpec("pi");
  const original = host.hook.parsePayload;
  t.after(() => { host.hook.parsePayload = original; });
  host.hook.parsePayload = () => ({ sessionId: "registry-session", cwd: "/registry", transcriptPath: registryTranscript });
  const writer = await startWriter(root);
  const errors = [];
  try {
    assert.equal(await runHookCommand({
      home, agentKind: "pi", event: "SessionStart",
      stdin: JSON.stringify({ session_id: "raw-session", cwd: "/raw", transcript_path: rawTranscript }),
      fetch: async () => assert.fail("no network expected"),
      stdout: () => {}, stderr: (s) => errors.push(s),
    }), 0);
  } finally { await writer.close(); }
  assert.deepEqual(errors, []);
  const after = await openStore(root, profileId);
  let snapshot;
  try { snapshot = await after.read(); } finally { await after.close(); }
  const bindings = Object.values(snapshot.bindings);
  assert.equal(bindings.length, 1, "runtime_event must reach the real writer and create one binding");
  assert.equal(bindings[0].native_session_id, "registry-session");
  assert.equal(bindings[0].runtime_kind, "pi");
  assert.equal(bindings[0].profile_id, profileId);
  assert.equal(bindings[0].device_id, deviceId);
  assert.equal(bindings[0].soul_uid, "s1");
  assert.equal(bindings[0].state, "bound");
  const pointerDir = path.join(root, "sources", profileId);
  const pointers = await readdir(pointerDir);
  assert.equal(pointers.length, 1, "runtime_event must also persist the registered source pointer");
  const pointer = JSON.parse(await readFile(path.join(pointerDir, pointers[0]), "utf8"));
  assert.equal(pointer.native_session_id, "registry-session");
  assert.equal(pointer.path, registryTranscript);
  assert.notEqual(pointer.path, rawTranscript);
});

test("hosts: doctor delegates registered host checks in place", async (t) => {
  const { runDoctor } = await import("../dist/doctor.js");
  const { saveConfig } = await import("../dist/agentd/state.js");
  const home = await mkdtemp(path.join(tmpdir(), "37soul-doctor-dispatch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await saveConfig(path.join(home, ".37soul"), { api_base_url: "https://app.test", machine_id: "m1", tokens: { pi: "" } });
  const host = hostSpec("pi");
  const original = host.doctor;
  t.after(() => { host.doctor = original; });
  const expected = { name: "pi: registry check", ok: false, detail: "unchanged dispatch contract" };
  host.doctor = async () => [expected];
  const result = await runDoctor({ home, apiBase: "https://app.test", nodePath: process.execPath, cliScriptPath: "/pkg/dist/cli.js", platform: "darwin", fetch: async () => { throw new Error("no network"); }, runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.deepEqual(result.checks.find((c) => c.name === expected.name), expected);
});

test("hosts: install and uninstall delegate host actions and manifest entries", async (t) => {
  const { install, uninstall } = await import("../dist/install.js");
  const { writeFile } = await import("node:fs/promises");
  const home = await mkdtemp(path.join(tmpdir(), "37soul-install-dispatch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = path.join(home, "package");
  await mkdir(path.join(source, "dist/bundle"), { recursive: true });
  await writeFile(path.join(source, "dist/bundle/cli.js"), "// fake bundled CLI\n");
  await writeFile(path.join(source, "dist/bundle/index.js"), "// fake bundled server\n");
  const host = hostSpec("pi");
  const originalConfigure = host.install.configure;
  const originalUninstall = host.install.uninstall;
  t.after(() => { host.install.configure = originalConfigure; host.install.uninstall = originalUninstall; });
  let configured = 0;
  host.install.configure = async () => { configured++; return { hook: false, instructions: false, mcp: false, manifestEntries: [{ agent: "pi", kind: "registry-entry", file: path.join(home, "registry-entry") }] }; };
  host.install.uninstall = async (_deps, removed) => { removed.push("registry-cleanup"); };
  const deps = { home, apiBase: "https://app.test", nodePath: process.execPath, cliScriptPath: "/pkg/dist/cli.js", agentdScriptPath: "/pkg/dist/cli.js", platform: "darwin", runtimeSourceRoot: source, runtimeVersion: "0.13.2", fetch: async () => { throw new Error("no network"); }, runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) };
  await install(deps, { agents: ["pi"], installService: false });
  assert.equal(configured, 1);
  const manifest = JSON.parse(await readFile(path.join(home, ".37soul/install-manifest.json"), "utf8"));
  assert.deepEqual(manifest.entries.filter((e) => e.agent), [{ agent: "pi", kind: "registry-entry", file: path.join(home, "registry-entry") }]);
  assert.ok((await uninstall(deps)).includes("registry-cleanup"));
});

test("hosts: null hook payload keeps the legacy error receipt", async (t) => {
  const { runHookCommand } = await import("../dist/hook.js");
  const home = await mkdtemp(path.join(tmpdir(), "37soul-null-payload-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const agentKind of [...LEGACY_KINDS, "unknown"]) {
    const errors = [];
    assert.equal(await runHookCommand({ home, agentKind, event: "SessionEnd", stdin: "null", fetch: async () => { throw new Error("no network"); }, stdout: () => assert.fail("no output expected"), stderr: s => errors.push(s) }), 0);
    assert.deepEqual(errors, ["37soul hook: Cannot read properties of null (reading 'session_id')\n"]);
  }
});
