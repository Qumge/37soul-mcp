#!/usr/bin/env node
/**
 * 安装器：设备码登录、各 Agent 配置写入、备份、服务文件、卸载。
 * 全部在临时 home 上跑，运行时用 fake runCommand，不碰真实用户配置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  install,
  installManifestPath,
  planInstall,
  uninstall,
  detectAgents,
  dataRoot,
  claudeSettingsPath,
  claudeInstructionsPath,
  codexInstructionsPath,
  hookCommand,
} from "../dist/install.js";
import { plistPath, systemdPath } from "../dist/service.js";
import { loadConfig } from "../dist/agentd/state.js";

function tempHome() {
  const home = mkdtempSync(path.join(tmpdir(), "37soul-install-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    const reply = await handler({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined }, calls.length);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      async json() {
        return reply.body ?? {};
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function deviceFlowFetch({ polls = [{ status: 201, body: { tokens: [{ agent_kind: "claude-code", token: "TOKEN-CLAUDE" }, { agent_kind: "codex", token: "TOKEN-CODEX" }] } }] } = {}) {
  let index = 0;
  return fakeFetch((request) => {
    if (request.url.endsWith("/api/v1/cli/device_codes")) {
      return {
        status: 201,
        body: {
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_url: "https://app.test/cli/approve?code=ABCD-EFGH",
          interval: 5,
          expires_in: 600,
        },
      };
    }
    const reply = polls[Math.min(index, polls.length - 1)];
    index += 1;
    return reply;
  });
}

function harness(overrides = {}) {
  const { home, cleanup } = overrides.home ? { home: overrides.home, cleanup: () => {} } : tempHome();
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  const commands = [];
  const logs = [];
  const sleeps = [];
  const deps = {
    home,
    apiBase: "https://app.test",
    fetch: overrides.fetch ?? deviceFlowFetch(),
    runCommand: async (argv) => {
      commands.push(argv);
      return overrides.runCommand ? overrides.runCommand(argv) : { code: 0, stdout: "", stderr: "" };
    },
    nodePath: overrides.nodePath ?? "/usr/local/bin/node",
    cliScriptPath: "/opt/37soul/dist/cli.js",
    agentdScriptPath: "/opt/37soul/dist/cli.js",
    platform: overrides.platform ?? "darwin",
    now: () => Date.parse("2026-10-17T06:00:00.000Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logs.push(line),
  };
  return { home, deps, commands, logs, sleeps, cleanup };
}

test("install: detects installed agents and only configures the selected ones", async () => {
  const h = harness();
  assert.deepEqual(await detectAgents(h.home), ["claude-code", "codex"]);

  const result = await install(h.deps, { agents: ["claude-code"] });

  assert.deepEqual(result.installed.map((entry) => entry.agentKind), ["claude-code"]);
  assert.deepEqual(result.skipped, ["codex"]);
  const config = await loadConfig(dataRoot(h.home));
  assert.equal(config.tokens["claude-code"], "TOKEN-CLAUDE");
  assert.equal(config.tokens.codex, undefined);
  h.cleanup();
});

test("install: polls the device endpoint until approval and stores one token per agent", async () => {
  const fetchImpl = deviceFlowFetch({
    polls: [
      { status: 202, body: { status: "pending" } },
      { status: 201, body: { tokens: [{ agent_kind: "claude-code", token: "T1" }, { agent_kind: "codex", token: "T2" }] } },
    ],
  });
  const h = harness({ fetch: fetchImpl });

  const result = await install(h.deps, { agents: ["claude-code", "codex"] });

  assert.equal(result.installed.length, 2);
  assert.ok(h.logs.some((line) => line.includes("ABCD-EFGH")), "human code must be shown");
  assert.deepEqual(h.sleeps, [5000]);
  const config = await loadConfig(dataRoot(h.home));
  assert.deepEqual(config.tokens, { "claude-code": "T1", codex: "T2" });
  h.cleanup();
});

test("install: an expired or cancelled login fails before touching any config", async () => {
  const expired = harness({ fetch: deviceFlowFetch({ polls: [{ status: 410, body: { error: "expired" } }] }) });
  await assert.rejects(() => install(expired.deps, { agents: ["claude-code"] }), /expired/);
  assert.equal(statSync(claudeSettingsPath(expired.home), { throwIfNoEntry: false }), undefined, "settings untouched");
  expired.cleanup();

  const cancelled = harness({ fetch: deviceFlowFetch({ polls: [{ status: 404, body: { error: "unknown_device_code" } }] }) });
  await assert.rejects(() => install(cancelled.deps, { agents: ["claude-code"] }), /cancelled/);
  cancelled.cleanup();
});

test("install: backs up with a timestamp before every change, keeps unrelated hooks, and stays idempotent", async () => {
  const h = harness();
  const settings = claudeSettingsPath(h.home);
  const original = {
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }] },
    theme: "dark",
  };
  writeFileSync(settings, `${JSON.stringify(original, null, 2)}\n`);
  writeFileSync(claudeInstructionsPath(h.home), "My own notes.\n");

  await install(h.deps, { agents: ["claude-code"] });
  await install(h.deps, { agents: ["claude-code"] });

  const document = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(document.theme, "dark");
  assert.equal(document.hooks.SessionStart.length, 2, "user hook + exactly one of ours");
  assert.equal(
    document.hooks.SessionStart.filter((entry) => entry.hooks.some((hook) => hook.command.includes("hook --agent claude-code"))).length,
    1,
  );
  assert.equal(document.hooks.SessionStart[0].hooks[0].command, "echo mine");
  // v2 §6.1：Claude Code 订阅整套事件（SessionStart/UserPromptSubmit/PostToolUse/Stop/PreCompact/SessionEnd）。
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact", "SessionEnd"]) {
    const mine = (document.hooks[event] ?? []).filter((entry) =>
      entry.hooks.some((hook) => hook.command.includes("hook --agent claude-code")),
    );
    assert.equal(mine.length, 1, `${event} should have exactly one of our entries`);
    assert.match(mine[0].hooks[0].command, new RegExp(`--event ${event}\\b`));
  }

  const backups = readdirSync(path.dirname(settings)).filter((name) => name.startsWith("settings.json.37soul-"));
  assert.ok(backups.length >= 1, "at least one timestamped backup");
  const backup = JSON.parse(readFileSync(path.join(path.dirname(settings), backups.sort()[0]), "utf8"));
  assert.deepEqual(backup, original, "backup holds the pre-install file");

  const instructions = readFileSync(claudeInstructionsPath(h.home), "utf8");
  assert.equal(instructions.startsWith("My own notes."), true);
  assert.equal(instructions.split("37soul:begin").length, 2, "managed fragment appears exactly once");
  h.cleanup();
});

test("install: a malformed existing config aborts before any mutation", async () => {
  const h = harness();
  writeFileSync(claudeSettingsPath(h.home), "{ this is not json");

  await assert.rejects(() => install(h.deps, { agents: ["claude-code"] }), /not valid JSON/);

  assert.equal(readFileSync(claudeSettingsPath(h.home), "utf8"), "{ this is not json");
  assert.equal(statSync(claudeSettingsPath(h.home) + ".37soul.bak", { throwIfNoEntry: false }), undefined);
  h.cleanup();
});

test("install: credentials file is mode 0600", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });

  const mode = statSync(path.join(dataRoot(h.home), "config.json")).mode & 0o777;
  assert.equal(mode, 0o600);
  h.cleanup();
});

test("install: writes the macOS LaunchAgent with absolute argv and XML escaping", async () => {
  const h = harness({ nodePath: "/Applications/Node & Friends/node" });
  await install(h.deps, { agents: ["claude-code"] });

  const plist = readFileSync(plistPath(h.home), "utf8");
  assert.ok(plist.includes("<string>/Applications/Node &amp; Friends/node</string>"));
  assert.ok(plist.includes("<string>/opt/37soul/dist/cli.js</string>"));
  const load = h.commands.find((argv) => argv[0] === "launchctl");
  assert.deepEqual(load, ["launchctl", "load", "-w", plistPath(h.home)]);
  h.cleanup();
});

test("install: writes a systemd user unit on Linux and enables it", async () => {
  const h = harness({ platform: "linux", nodePath: "/usr/bin/node with space" });
  await install(h.deps, { agents: ["claude-code"] });

  const unit = readFileSync(systemdPath(h.home), "utf8");
  assert.ok(unit.includes('ExecStart="/usr/bin/node with space" "/opt/37soul/dist/cli.js" "agentd"'));
  assert.ok(h.commands.some((argv) => argv.join(" ") === "systemctl --user enable --now 37soul-agentd.service"));
  h.cleanup();
});

test("install: a failing service registration rolls back the service file but keeps the connection", async () => {
  const h = harness({ runCommand: (argv) => (argv[0] === "launchctl" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" }) });

  const result = await install(h.deps, { agents: ["claude-code"] });

  assert.equal(result.installed.length, 1);
  assert.equal(statSync(plistPath(h.home), { throwIfNoEntry: false }), undefined, "failed service file removed");
  assert.ok(readFileSync(claudeSettingsPath(h.home), "utf8").includes("hook --agent claude-code"), "hook config stays — MCP/hook still work");
  h.cleanup();
});

test("uninstall: removes only our entries and is idempotent", async () => {
  const h = harness();
  const settings = claudeSettingsPath(h.home);
  const userHook = { matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] };
  writeFileSync(settings, `${JSON.stringify({ hooks: { SessionStart: [userHook] } }, null, 2)}\n`);
  writeFileSync(claudeInstructionsPath(h.home), "My own notes.\nKeep me.\n");
  writeFileSync(codexInstructionsPath(h.home), "Codex notes.\n");

  await install(h.deps, { agents: ["claude-code", "codex"] });
  const first = await uninstall(h.deps);

  const document = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(document.hooks.SessionStart, [userHook], "user hook untouched");
  assert.equal(readFileSync(claudeInstructionsPath(h.home), "utf8").includes("My own notes."), true);
  assert.equal(readFileSync(claudeInstructionsPath(h.home), "utf8").includes("37soul:begin"), false);
  assert.equal(readFileSync(codexInstructionsPath(h.home), "utf8").includes("37soul:begin"), false);
  assert.equal(statSync(plistPath(h.home), { throwIfNoEntry: false }), undefined);
  assert.equal(statSync(dataRoot(h.home), { throwIfNoEntry: false }), undefined);
  assert.ok(first.length > 0);

  const second = await uninstall(h.deps);
  assert.deepEqual(second, [], "nothing left for us to own");
  h.cleanup();
});

test("hook command in settings points at the absolute cli.js path", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });

  const document = JSON.parse(readFileSync(claudeSettingsPath(h.home), "utf8"));
  const command = document.hooks.SessionStart.find((entry) =>
    entry.hooks.some((hook) => hook.command.includes("hook --agent claude-code")),
  ).hooks[0].command;

  assert.equal(command, hookCommand(h.deps, "claude-code"));
  assert.ok(command.startsWith('"/usr/local/bin/node" "/opt/37soul/dist/cli.js"'));
  h.cleanup();
});

test("install: --plan lists the files it would touch and writes nothing", async () => {
  const h = harness();

  const plan = await planInstall(h.deps, { agents: ["claude-code"] });

  assert.deepEqual(plan.agents, ["claude-code"]);
  assert.ok(plan.files.some((file) => file.endsWith(".claude/settings.json")));
  assert.ok(plan.files.some((file) => file.endsWith("CLAUDE.md")));
  assert.ok(plan.files.some((file) => file.endsWith("config.json")));
  assert.ok(plan.files.some((file) => file.endsWith("install-manifest.json")));
  assert.ok(plan.serviceFile);
  assert.equal(statSync(claudeSettingsPath(h.home), { throwIfNoEntry: false }), undefined);
  assert.equal(statSync(dataRoot(h.home), { throwIfNoEntry: false }), undefined, "plan must not create the data root");
  h.cleanup();
});

test("install: records an install manifest and defaults Codex to transcript fallback", async () => {
  const h = harness();

  await install(h.deps, { agents: ["claude-code", "codex"] });

  const manifest = JSON.parse(readFileSync(installManifestPath(h.home), "utf8"));
  const kinds = manifest.entries.map((entry) => entry.kind);
  assert.ok(kinds.includes("hooks"));
  assert.ok(kinds.includes("fragment"));
  assert.ok(kinds.includes("config"));
  assert.ok(kinds.includes("service"));
  const hooksEntry = manifest.entries.find((entry) => entry.kind === "hooks");
  assert.ok(hooksEntry.events.includes("SessionStart") && hooksEntry.events.includes("SessionEnd"));

  const config = await loadConfig(dataRoot(h.home));
  assert.deepEqual(config.transcript_fallback, ["codex"], "Codex hook needs trust; fallback until verified");
  h.cleanup();
});
