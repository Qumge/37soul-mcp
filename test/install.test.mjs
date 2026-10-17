#!/usr/bin/env node
/**
 * 安装器：设备码登录、各 Agent 配置写入、备份、服务文件、卸载。
 * 全部在临时 home 上跑，运行时用 fake runCommand，不碰真实用户配置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
import { plistPath, renderPlist, systemdPath } from "../dist/service.js";
import { installRuntime, runtimeDir, runtimeLauncher, binLinkPath, linkBin } from "../dist/install.js";
import { loadConfig } from "../dist/agentd/state.js";
import { runDoctor } from "../dist/doctor.js";

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

function fakeSourceRoot() {
  // 模拟发布包布局：只有 esbuild 打好的 dist/bundle（自包含），没有 node_modules。
  const dir = mkdtempSync(path.join(tmpdir(), "37soul-pkg-"));
  mkdirSync(path.join(dir, "dist", "bundle"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "bundle", "cli.js"), "// bundled cli\n");
  writeFileSync(path.join(dir, "dist", "bundle", "index.js"), "// bundled index\n");
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "37soul-mcp", version: "0.11.0" }, null, 2)}\n`);
  return dir;
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
    runtimeSourceRoot: overrides.runtimeSourceRoot ?? fakeSourceRoot(),
    runtimeVersion: "0.11.0",
    openBrowser: overrides.openBrowser ?? false,
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

test("install: writes the macOS LaunchAgent pointing at the fixed runtime launcher, with XML escaping", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });

  const launcher = runtimeLauncher(h.home, "0.11.0");
  const plist = readFileSync(plistPath(h.home), "utf8");
  assert.ok(plist.includes(`<string>${launcher}</string>`), "service must run the runtime launcher");
  assert.ok(plist.includes("<string>agentd</string>"));
  assert.ok(plist.includes("<string>/opt/37soul/dist/cli.js</string>") === false, "must not point into the checkout/npx cache");
  const load = h.commands.find((argv) => argv[0] === "launchctl");
  assert.deepEqual(load, ["launchctl", "load", "-w", plistPath(h.home)]);

  // 转义本身单独钉住（路径里可能有 & / < / 空格）。
  const escaped = renderPlist({ home: h.home, nodePath: "/n & n", scriptPath: "/s <x>", launcherPath: "/l & <l>", logPath: "/tmp/l" });
  assert.ok(escaped.includes("<string>/l &amp; &lt;l&gt;</string>"));
  h.cleanup();
});

test("install: writes a systemd user unit on Linux and enables it", async () => {
  const h = harness({ platform: "linux" });
  await install(h.deps, { agents: ["claude-code"] });

  const launcher = runtimeLauncher(h.home, "0.11.0");
  const unit = readFileSync(systemdPath(h.home), "utf8");
  assert.ok(unit.includes(`ExecStart="${launcher}" "agentd"`));
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

test("hook command in settings points at the fixed runtime launcher, not the npx/checkout paths", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });

  const launcher = runtimeLauncher(h.home, "0.11.0");
  const document = JSON.parse(readFileSync(claudeSettingsPath(h.home), "utf8"));
  const command = document.hooks.SessionStart.find((entry) =>
    entry.hooks.some((hook) => hook.command.includes("hook --agent claude-code")),
  ).hooks[0].command;

  assert.equal(command, hookCommand({ ...h.deps, launcher }, "claude-code", "SessionStart"));
  assert.ok(command.startsWith(`"${launcher}"`));
  assert.ok(!command.includes("/opt/37soul"), "must not reference the transient source path");
  h.cleanup();
});

test("install: copies the bundled runtime to a fixed location and writes a fast node-resolving launcher", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });

  const dir = runtimeDir(h.home, "0.11.0");
  const launcher = runtimeLauncher(h.home, "0.11.0");
  assert.ok(statSync(path.join(dir, "dist", "cli.js")).isFile(), "bundled cli copied");
  assert.ok(statSync(path.join(dir, "dist", "index.js")).isFile(), "bundled mcp server copied");
  assert.equal(statSync(path.join(dir, "node_modules"), { throwIfNoEntry: false }), undefined, "bundles need no node_modules");
  assert.ok(statSync(path.join(dir, ".installed")).isFile());

  const script = readFileSync(launcher, "utf8");
  assert.ok(script.startsWith("#!/bin/bash"));
  assert.ok(script.includes('command -v node'), "resolves node at run time");
  assert.ok(script.includes(h.deps.nodePath), "records the install-time node as a fallback");
  assert.ok(script.includes(".nvm/versions/node/*/bin/node"), "survives nvm version switches");
  assert.ok(script.includes("SOUL37_ENTRY:-dist/cli.js"));
  // 审查修复：每个 hook 都要付启动器开销，绝不额外起一个 node 做版本检查
  // （`command -v node` 是 shell 内建查找，不算）。
  const flagged = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => line.includes(" -v") && !line.includes("command -v"));
  assert.deepEqual(flagged, [], "must not spawn node just to validate it");
  const recordedIndex = script.indexOf(h.deps.nodePath);
  const pathIndex = script.indexOf("command -v node");
  assert.ok(recordedIndex !== -1 && pathIndex !== -1 && recordedIndex < pathIndex,
    "recorded node wins over PATH (an old PATH node must not shadow it)");

  // 重复安装幂等：再跑一次不炸、路径不变。
  await install(h.deps, { agents: ["claude-code"] });
  assert.ok(statSync(launcher).isFile());
  h.cleanup();
});

test("install: hoisted npm layout (bundles only, no node_modules) serves MCP through the launcher", async () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bundleRoot = path.join(repoRoot, "dist", "bundle");
  assert.ok(statSync(path.join(bundleRoot, "cli.js")).isFile(), "`npm run bundle` must run before this test");

  // 模拟 npm/npx 的真实布局：依赖被提升出去，包目录里只有 dist/bundle。
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "37soul-packed-"));
  mkdirSync(path.join(sourceRoot, "dist", "bundle"), { recursive: true });
  copyFileSync(path.join(bundleRoot, "cli.js"), path.join(sourceRoot, "dist", "bundle", "cli.js"));
  copyFileSync(path.join(bundleRoot, "index.js"), path.join(sourceRoot, "dist", "bundle", "index.js"));

  const home = mkdtempSync(path.join(tmpdir(), "37soul-hoisted-"));
  const runtime = await installRuntime({ home, sourceRoot, version: "0.11.0", nodePath: process.execPath });
  assert.equal(runtime.mode, "bundle");
  assert.equal(statSync(path.join(runtime.dir, "node_modules"), { throwIfNoEntry: false }), undefined);

  const result = await mcpInitialize(runtime.launcher, {
    SOUL37_ENTRY: "dist/index.js",
    SOUL37_API_TOKEN: "tok_test",
    SOUL37_BASE_URL: "http://127.0.0.1:1",
  });
  assert.equal(result.serverInfo.name, "37soul");

  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("install: refuses a source layout with neither bundles nor dependencies instead of installing a broken runtime", async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "37soul-broken-"));
  mkdirSync(path.join(sourceRoot, "dist"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "dist", "cli.js"), "// tsc output that needs hoisted deps\n");
  const home = mkdtempSync(path.join(tmpdir(), "37soul-broken-home-"));

  await assert.rejects(
    () => installRuntime({ home, sourceRoot, version: "0.11.0", nodePath: process.execPath }),
    /node_modules|npm run bundle/,
  );

  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("install: falls back to copying dist + node_modules for a checkout without bundles", async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "37soul-checkout-"));
  mkdirSync(path.join(sourceRoot, "dist"), { recursive: true });
  mkdirSync(path.join(sourceRoot, "node_modules", "some-dep"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "dist", "cli.js"), "// tsc cli\n");
  writeFileSync(path.join(sourceRoot, "node_modules", "some-dep", "index.js"), "// dep\n");
  const home = mkdtempSync(path.join(tmpdir(), "37soul-checkout-home-"));

  const runtime = await installRuntime({ home, sourceRoot, version: "0.11.0", nodePath: process.execPath });

  assert.equal(runtime.mode, "deps");
  assert.ok(statSync(path.join(runtime.dir, "node_modules", "some-dep", "index.js")).isFile());

  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function mcpInitialize(entry, env = {}) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(entry, [], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("initialize timed out"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && message.result) {
            clearTimeout(timer);
            child.kill();
            resolve(message.result);
          }
        } catch {
          // partial line
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`,
    );
  });
}

test("install: configures Codex MCP with the issued token via env (no manual login)", async () => {
  const h = harness();
  await install(h.deps, { agents: ["codex"] });

  const codexAdd = h.commands.find((argv) => argv[0] === "codex" && argv[1] === "mcp" && argv[2] === "add");
  assert.ok(codexAdd, "codex mcp add must run");
  assert.ok(codexAdd.includes("--env"));
  assert.ok(codexAdd.includes("SOUL37_API_TOKEN=TOKEN-CODEX"));
  assert.ok(codexAdd.includes("SOUL37_ENTRY=dist/index.js"));
  assert.ok(codexAdd.includes("--"));
  assert.ok(codexAdd.at(-1) === runtimeLauncher(h.home, "0.11.0"), "runs the fixed runtime launcher");
  h.cleanup();
});

test("doctor: checks that the runtime launcher, node and service paths still exist", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });

  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return { text: "brief" }; } });
  const doctorDeps = { ...h.deps, fetch: fetchImpl };
  const healthy = await runDoctor(doctorDeps);
  const byName = (report) => Object.fromEntries(report.checks.map((c) => [c.name, c]));
  assert.equal(byName(healthy)["runtime: launcher"].ok, true);
  assert.equal(byName(healthy)["runtime: node"].ok, true);
  assert.equal(byName(healthy)["runtime: service"].ok, true);

  rmSync(runtimeLauncher(h.home, "0.11.0"), { force: true });
  const broken = await runDoctor(doctorDeps);
  assert.equal(byName(broken)["runtime: launcher"].ok, false);
  assert.equal(byName(broken)["runtime: launcher"].detail.includes("37soul install"), true);
  assert.equal(broken.ok, false, "a broken runtime must fail doctor loudly");
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

test("uninstall: clears our entries from every Claude hook event, not just SessionStart", async () => {
  const h = harness();
  const settings = claudeSettingsPath(h.home);
  const userStop = { hooks: [{ type: "command", command: "say done" }] };
  writeFileSync(settings, `${JSON.stringify({ hooks: { Stop: [userStop] } }, null, 2)}\n`);

  await install(h.deps, { agents: ["claude-code"] });
  const installed = JSON.parse(readFileSync(settings, "utf8"));
  assert.ok(installed.hooks.PostToolUse, "install wires PostToolUse");

  await uninstall(h.deps);
  const document = JSON.parse(readFileSync(settings, "utf8"));
  const leftovers = Object.values(document.hooks ?? {}).flat().filter((entry) =>
    entry.hooks.some((hook) => hook.command.includes("hook --agent claude-code")),
  );
  assert.deepEqual(leftovers, [], "no 37soul hook left behind in any event");
  assert.deepEqual(document.hooks.Stop, [userStop], "user hook untouched");
  h.cleanup();
});

test("install: links ~/.local/bin/37soul to the runtime launcher and uninstall removes only that link", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });
  const link = binLinkPath(h.home);
  assert.equal(readlinkSync(link), runtimeLauncher(h.home, "0.11.0"));

  await install(h.deps, { agents: ["claude-code"] }); // 幂等
  assert.equal(readlinkSync(link), runtimeLauncher(h.home, "0.11.0"));

  await uninstall(h.deps);
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
  h.cleanup();
});

test("install: never overwrites a user's own ~/.local/bin/37soul", async () => {
  const h = harness();
  mkdirSync(path.dirname(binLinkPath(h.home)), { recursive: true });
  writeFileSync(binLinkPath(h.home), "#!/bin/sh\necho mine\n");
  assert.equal(await linkBin(h.home, runtimeLauncher(h.home, "0.11.0")), false);
  assert.equal(readFileSync(binLinkPath(h.home), "utf8"), "#!/bin/sh\necho mine\n");

  await install(h.deps, { agents: ["claude-code"] });
  await uninstall(h.deps);
  assert.equal(readFileSync(binLinkPath(h.home), "utf8"), "#!/bin/sh\necho mine\n", "uninstall leaves it too");
  h.cleanup();
});

test("install: opens the approval page in the browser when allowed", async () => {
  const h = harness({ openBrowser: true });
  await install(h.deps, { agents: ["claude-code"] });
  assert.ok(h.commands.some((argv) => argv[0] === "open" && argv[1] === "https://app.test/cli/approve?code=ABCD-EFGH"));
  h.cleanup();
});

test("install: run from the release tarball layout (dist/bundle/cli.js) finds the package root", async () => {
  const source = fakeSourceRoot();
  const h = harness({ runtimeSourceRoot: undefined });
  delete h.deps.runtimeSourceRoot;
  h.deps.cliScriptPath = path.join(source, "dist", "bundle", "cli.js");
  h.deps.agentdScriptPath = h.deps.cliScriptPath;
  await install(h.deps, { agents: ["claude-code"] });
  assert.equal(readFileSync(path.join(runtimeDir(h.home, "0.11.0"), "dist", "cli.js"), "utf8"), "// bundled cli\n");
  h.cleanup();
});

test("launcher works when called through the ~/.local/bin/37soul symlink", async () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "37soul-packed-"));
  mkdirSync(path.join(sourceRoot, "dist", "bundle"), { recursive: true });
  for (const file of ["cli.js", "index.js"]) {
    copyFileSync(path.join(repoRoot, "dist", "bundle", file), path.join(sourceRoot, "dist", "bundle", file));
  }
  const home = mkdtempSync(path.join(tmpdir(), "37soul-link-"));
  const runtime = await installRuntime({ home, sourceRoot, version: "0.11.0", nodePath: process.execPath });
  assert.equal(await linkBin(home, runtime.launcher), true);

  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(binLinkPath(home), ["status"], { env: { ...process.env, SOUL37_HOME: home }, encoding: "utf8" });
  assert.match(out, /machine: \(not installed\)/);

  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
