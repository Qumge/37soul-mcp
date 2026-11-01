import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOSTS, hostSpec, SUPPORTED_AGENTS, AGENT_HOMES } from "../dist/hosts/registry.js";
import { RUNTIME_KINDS } from "../dist/assets/protocol.js";
import { detectAgents, planInstall } from "../dist/install.js";
import { createExtractAdapters } from "../dist/agentd/native-invoker.js";

const KINDS = ["claude-code", "codex", "opencode", "hermes", "pi"];

test("hosts: registry covers the protocol in order with unique homes and complete dispatch", () => {
  assert.deepEqual(HOSTS.map((host) => host.kind), KINDS);
  assert.deepEqual(HOSTS.map((host) => host.kind), RUNTIME_KINDS);
  assert.deepEqual(SUPPORTED_AGENTS, RUNTIME_KINDS);
  assert.equal(new Set(HOSTS.map((host) => host.home)).size, 5);
  assert.deepEqual(Object.values(AGENT_HOMES), [".claude", ".codex", ".config/opencode", ".hermes", ".pi", ".gemini"]);
  for (const host of HOSTS) {
    assert.equal(hostSpec(host.kind), host);
    for (const method of ["plan", "configure", "uninstall"]) assert.equal(typeof host.install[method], "function");
    assert.equal(typeof host.hook.parsePayload, "function");
    assert.equal(typeof host.doctor, "function");
  }
  assert.equal(hostSpec("gemini-cli"), undefined);
  assert.equal(hostSpec("unknown"), undefined);
});

test("hosts: detection keeps Gemini visible and plan preserves the existing file order", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "37soul-hosts-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".gemini"));
  assert.deepEqual(await detectAgents(home), ["gemini-cli"]);
  for (const dir of [".claude", ".codex", ".config/opencode", ".hermes", ".pi"]) {
    await mkdir(path.join(home, dir), { recursive: true });
  }
  assert.deepEqual(await detectAgents(home), [...KINDS, "gemini-cli"]);
  const deps = { home, cliScriptPath: "/pkg/dist/cli.js", runtimeVersion: "0.13.2", platform: "darwin" };
  const plan = await planInstall(deps);
  const hostFiles = [
    [".claude/settings.json", ".claude/CLAUDE.md"],
    [".codex/AGENTS.md", ".codex/hooks.json"],
    [".config/opencode/plugins/37soul-soul.js"],
    [".hermes/agent-hooks/37soul-hook.py"],
    [".pi/agent/extensions/37soul-soul.ts"],
  ];
  const commonFiles = [".37soul/config.json", ".37soul/install-manifest.json", ".37soul/runtime/0.13.2", ".local/bin/37soul"];
  const absolute = (files) => files.map((file) => path.join(home, file));
  assert.deepEqual(plan.agents, KINDS);
  assert.deepEqual(plan.unsupported, ["gemini-cli"]);
  assert.deepEqual(plan.files, absolute([...hostFiles.flat(), ...commonFiles]));
  for (const [index, kind] of KINDS.entries()) {
    assert.deepEqual((await planInstall(deps, { agents: [kind] })).files, absolute([...hostFiles[index], ...commonFiles]));
  }
  assert.deepEqual((await planInstall(deps, { agents: [...KINDS].reverse() })).files, plan.files);
});

test("hosts: extraction still constructs all five adapters", () => {
  const adapters = createExtractAdapters("/unused-host-registry-home");
  assert.deepEqual(Object.keys(adapters), KINDS);
  for (const kind of KINDS) assert.equal(adapters[kind].runtime_kind, kind);
});

test("hosts: Claude completed-turn parser preserves fixture refs", async () => {
  const transcript = await readFile(new URL("./fixtures/runtimes/claude-code/stop-turn.jsonl", import.meta.url), "utf8");
  assert.deepEqual(hostSpec("claude-code").hook.completedTurnRefs(transcript), ["c-u6", "c-a5"]);
});
