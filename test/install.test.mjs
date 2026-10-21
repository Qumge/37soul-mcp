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
import { loadConfig, saveConfig } from "../dist/agentd/state.js";
import { openStore } from "../dist/local/store.js";
import { runDoctor } from "../dist/doctor.js";
import { codexHookConfigPath } from "../dist/adapters/codex.js";
import {
  OPENCODE_PLUGIN_FILENAME,
  OPENCODE_PLUGIN_SOURCE,
  openCodePluginDir,
  openCodePluginGeneration,
  openCodePluginPath,
  openCodePluginSha256,
} from "../dist/adapters/opencode.js";
import {
  HERMES_PLUGIN_FILENAME,
  HERMES_PLUGIN_SOURCE,
  hermesConfigPath,
  hermesPluginDir,
  hermesPluginPath,
  hermesPluginSha256,
} from "../dist/adapters/hermes.js";

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
  // Anonymous-first install: no device login, so no token is ever issued/stored.
  assert.deepEqual(config.tokens, {});
  assert.equal(h.deps.fetch.calls.length, 0, "install must make zero HTTP requests");
  h.cleanup();
});

test("install: offline setup does not login — zero HTTP, assets_only default, no sleeps", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code", "codex"] });

  // Zero HTTP: no device-code POST, no poll, no token fetch.
  assert.equal(h.deps.fetch.calls.length, 0, "anonymous-first install makes zero HTTP requests");
  assert.deepEqual(h.sleeps, [], "no polling sleeps");

  // The anonymous assets profile is established: accounts.json has the sentinel
  // owner marked assets_only, and snapshot.json carries the pinned device_id.
  const accounts = JSON.parse(readFileSync(path.join(dataRoot(h.home), "accounts.json"), "utf8"));
  assert.deepEqual(accounts.anonymous, {
    profile_id: "default",
    default_soul_uid: null,
    soul_sync_mode: "assets_only",
  });
  const snapshot = JSON.parse(readFileSync(path.join(dataRoot(h.home), "profiles", "default", "snapshot.json"), "utf8"));
  assert.equal(typeof snapshot.device_id, "string");
  assert.ok(snapshot.device_id.length > 0, "snapshot must carry a pinned device_id");
  assert.equal(snapshot.owner_id, null, "anonymous profile has no owner");

  // No token means no MCP server was registered for either runtime.
  assert.ok(!h.commands.some((argv) => argv[0] === "claude" && argv[1] === "mcp" && argv[2] === "add"), "no claude mcp add without a token");
  assert.ok(!h.commands.some((argv) => argv[0] === "codex" && argv[1] === "mcp" && argv[2] === "add"), "no codex mcp add without a token");
  h.cleanup();
});

test("install: an anonymous install never opens the browser or touches the device endpoint", async () => {
  const h = harness({ openBrowser: true });
  await install(h.deps, { agents: ["claude-code"] });
  assert.ok(!h.commands.some((argv) => argv[0] === "open"), "no browser open without a login");
  assert.equal(h.deps.fetch.calls.length, 0);
  h.cleanup();
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
  assert.ok(first.length > 0);

  const second = await uninstall(h.deps);
  assert.deepEqual(second, [], "nothing left for us to own");
  h.cleanup();
});

test("uninstall: retains all user assets and only removes managed runtime/config files", async () => {
  const h = harness();
  await install(h.deps, { agents: ["claude-code"] });

  // Pre-seed user assets that must survive: the anonymous profile snapshot, the
  // accounts index, a raw spool archive and an unsynced queue item.
  const root = dataRoot(h.home);
  const snapshotPath = path.join(root, "profiles", "default", "snapshot.json");
  const accountsPath = path.join(root, "accounts.json");
  mkdirSync(path.join(root, "spool", "claude-code"), { recursive: true });
  mkdirSync(path.join(root, "queue"), { recursive: true });
  writeFileSync(path.join(root, "spool", "claude-code", "sess.jsonl"), "{\"t\":1}\n");
  writeFileSync(path.join(root, "queue", "pending-1.json"), "{\"id\":\"pending-1\"}\n");
  const snapshotBefore = readFileSync(snapshotPath, "utf8");
  const accountsBefore = readFileSync(accountsPath, "utf8");

  await uninstall(h.deps);

  // User assets survive byte-for-byte.
  assert.ok(statSync(snapshotPath).isFile(), "profile snapshot survives");
  assert.equal(readFileSync(snapshotPath, "utf8"), snapshotBefore, "snapshot unchanged");
  assert.equal(readFileSync(accountsPath, "utf8"), accountsBefore, "accounts index unchanged");
  assert.equal(readFileSync(path.join(root, "spool", "claude-code", "sess.jsonl"), "utf8"), "{\"t\":1}\n", "raw spool archive survives");
  assert.equal(readFileSync(path.join(root, "queue", "pending-1.json"), "utf8"), "{\"id\":\"pending-1\"}\n", "unsynced queue survives");

  // Managed runtime/config entries are gone.
  assert.equal(statSync(path.join(root, "runtime"), { throwIfNoEntry: false }), undefined, "runtime dir removed");
  assert.equal(statSync(installManifestPath(h.home), { throwIfNoEntry: false }), undefined, "install manifest removed");
  assert.equal(statSync(path.join(root, "config.json"), { throwIfNoEntry: false }), undefined, "config removed");
  assert.equal(statSync(path.join(root, "ipc"), { throwIfNoEntry: false }), undefined, "ipc socket dir removed");

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

test("install: skips Codex MCP registration without a token (anonymous assets-only)", async () => {
  const h = harness();
  await install(h.deps, { agents: ["codex"] });

  const codexAdd = h.commands.find((argv) => argv[0] === "codex" && argv[1] === "mcp" && argv[2] === "add");
  assert.equal(codexAdd, undefined, "codex mcp add must NOT run without a token (would register a broken stdio server)");
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

test("install: records an install manifest and persists no transcript fallback in assets mode", async () => {
  const h = harness();

  await install(h.deps, { agents: ["claude-code", "codex"] });

  const manifest = JSON.parse(readFileSync(installManifestPath(h.home), "utf8"));
  const kinds = manifest.entries.map((entry) => entry.kind);
  assert.ok(kinds.includes("hooks"));
  assert.ok(kinds.includes("fragment"));
  assert.ok(kinds.includes("config"));
  assert.ok(kinds.includes("service"));
  assert.ok(kinds.includes("codex_hooks"), "the managed Codex hook-config file is recorded in the manifest");
  const hooksEntry = manifest.entries.find((entry) => entry.kind === "hooks");
  assert.ok(hooksEntry.events.includes("SessionStart") && hooksEntry.events.includes("SessionEnd"));
  const codexHooksEntry = manifest.entries.find((entry) => entry.kind === "codex_hooks");
  assert.ok(codexHooksEntry.events.includes("SessionStart") && codexHooksEntry.events.includes("SessionEnd"));

  const config = await loadConfig(dataRoot(h.home));
  assert.deepEqual(config.transcript_fallback, [], "assets mode persists no legacy transcript fallback");
  h.cleanup();
});

test("install: reports Codex hooks as installed-but-unverified and the AGENTS fragment carries no persona", async () => {
  const h = harness();

  const result = await install(h.deps, { agents: ["codex"] });
  const codexEntry = result.installed.find((entry) => entry.agentKind === "codex");

  // Five separate states; our own write never makes trust/events/injection green.
  assert.equal(codexEntry.hook, false);
  assert.deepEqual(codexEntry.report, {
    installed: true,
    trusted: false,
    events_seen: false,
    extraction_capable: false,
    injection_capable: false,
  });
  assert.ok(
    h.logs.some((line) => line.includes("codex") && line.includes("trusted=pending") && line.includes("injection=no")),
    "the honest five-state line is logged",
  );

  // The "installed" state is a file we wrote; it must not look like a trust marker.
  const hookConfig = JSON.parse(readFileSync(codexHookConfigPath(h.home), "utf8"));
  assert.equal(hookConfig.managed_by, "37soul");
  assert.equal(hookConfig.verified, false);
  assert.deepEqual(hookConfig.events, ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact", "SessionEnd"]);

  // The global AGENTS fragment carries no Soul identity — persona lives only in the
  // per-session ContextBundle.
  const fragment = readFileSync(codexInstructionsPath(h.home), "utf8");
  assert.ok(fragment.includes("37soul:begin"));
  assert.ok(!fragment.includes("soul_uid"));
  assert.ok(!fragment.includes("character:"));
  assert.ok(!fragment.includes("greeting:"));
  assert.ok(!fragment.includes("Growth"));

  h.cleanup();
});

test("install: Codex trust flips green only from a Codex-authored marker, never our own write", async () => {
  const h = harness();
  // A trust marker Codex itself wrote (UNVERIFIED marker path, modeled as data —
  // a section named 37soul-hooks with trusted = true in Codex's own config.toml).
  writeFileSync(path.join(h.home, ".codex", "config.toml"), "[hooks.37soul-hooks]\ntrusted = true\n", { mode: 0o600 });

  const result = await install(h.deps, { agents: ["codex"] });
  const codexEntry = result.installed.find((entry) => entry.agentKind === "codex");

  // Trusted flips green, but events_seen stays false: a trust marker means "Codex
  // may run the hook", not "Codex ran it" — no event has been observed.
  assert.deepEqual(codexEntry.report, {
    installed: true,
    trusted: true,
    events_seen: false,
    extraction_capable: false,
    injection_capable: true,
  });
  assert.ok(
    h.logs.some((line) => line.includes("codex") && line.includes("trusted=yes") && line.includes("events=no") && line.includes("injection=yes")),
    "trusted Codex hooks log green injection but events=no",
  );

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

function opencodeDeviceFlow() {
  return deviceFlowFetch({ polls: [{ status: 201, body: { tokens: [{ agent_kind: "opencode", token: "TOKEN-OPENCODE" }] } }] });
}

test("install: records the managed OpenCode plugin by exact path + SHA-256 and replaces only that entry", async () => {
  const h = harness({ fetch: opencodeDeviceFlow() });

  // A pre-existing unrelated plugin file must survive install untouched.
  const pluginDir = openCodePluginDir(h.home);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "some-other-plugin.js"), "export default {};\n", { mode: 0o600 });
  // A pre-existing file at OUR path gets backed up exactly once before replacement.
  writeFileSync(openCodePluginPath(h.home), 'export default { api_generation: "v1" };\n', { mode: 0o600 });

  await install(h.deps, { agents: ["opencode"] });

  const manifest = JSON.parse(readFileSync(installManifestPath(h.home), "utf8"));
  const pluginEntry = manifest.entries.find((entry) => entry.kind === "opencode_plugin");
  assert.ok(pluginEntry, "the managed plugin file is recorded in the manifest");
  assert.equal(pluginEntry.agent, "opencode");
  assert.equal(pluginEntry.file, openCodePluginPath(h.home));
  assert.equal(pluginEntry.generation, "v2");
  assert.equal(pluginEntry.sha256, openCodePluginSha256());

  // The installed file is exactly our source.
  assert.equal(readFileSync(openCodePluginPath(h.home), "utf8"), OPENCODE_PLUGIN_SOURCE);
  // The pre-existing v1 file was backed up, and the other vendor's plugin untouched.
  const backups = readdirSync(pluginDir).filter((name) => name.startsWith(`${OPENCODE_PLUGIN_FILENAME}.37soul-`));
  assert.equal(backups.length, 1, "the pre-install file is backed up exactly once");
  assert.equal(readFileSync(path.join(pluginDir, backups[0]), "utf8"), 'export default { api_generation: "v1" };\n');
  assert.equal(readFileSync(path.join(pluginDir, "some-other-plugin.js"), "utf8"), "export default {};\n");

  h.cleanup();
});

test("install: reports the OpenCode plugin as installed-but-unverified with generation", async () => {
  const h = harness({ fetch: opencodeDeviceFlow() });

  const result = await install(h.deps, { agents: ["opencode"] });
  const opencodeEntry = result.installed.find((entry) => entry.agentKind === "opencode");

  // No global hook / instructions / MCP: the plugin file is the only managed artifact.
  assert.equal(opencodeEntry.hook, false);
  assert.equal(opencodeEntry.instructions, false);
  assert.equal(opencodeEntry.mcp, false);
  // Five honest states + generation; our own write never makes trust/events green.
  assert.deepEqual(opencodeEntry.report, {
    installed: true,
    trusted: false,
    events_seen: false,
    extraction_capable: false,
    injection_capable: false,
    generation: "v2",
  });
  assert.ok(
    h.logs.some((line) => line.includes("opencode") && line.includes("trusted=pending") && line.includes("injection=no")),
    "the honest five-state line is logged",
  );

  // The installed file declares v2 for itself (a file write we performed, not trust).
  assert.equal(openCodePluginGeneration(readFileSync(openCodePluginPath(h.home), "utf8")).generation, "v2");

  h.cleanup();
});

test("uninstall: removes only the OpenCode plugin entry and leaves other plugins", async () => {
  const h = harness({ fetch: opencodeDeviceFlow() });

  const pluginDir = openCodePluginDir(h.home);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "some-other-plugin.js"), "export default {};\n", { mode: 0o600 });

  await install(h.deps, { agents: ["opencode"] });
  assert.ok(statSync(openCodePluginPath(h.home), { throwIfNoEntry: false }), "our plugin file exists after install");

  const removed = await uninstall(h.deps);
  assert.ok(removed.some((entry) => entry.includes(OPENCODE_PLUGIN_FILENAME)), "the plugin file removal is reported");
  assert.equal(statSync(openCodePluginPath(h.home), { throwIfNoEntry: false }), undefined, "our plugin file is gone");
  assert.equal(readFileSync(path.join(pluginDir, "some-other-plugin.js"), "utf8"), "export default {};\n", "another vendor's plugin survives");

  h.cleanup();
});

test("uninstall: a modified OpenCode plugin is backed up before removal, never destroyed", async () => {
  const h = harness({ fetch: opencodeDeviceFlow() });
  await install(h.deps, { agents: ["opencode"] });

  const pluginPath = openCodePluginPath(h.home);
  const pluginDir = openCodePluginDir(h.home);
  writeFileSync(pluginPath, "// user-modified\n", { mode: 0o600 });

  await uninstall(h.deps);

  assert.equal(statSync(pluginPath, { throwIfNoEntry: false }), undefined, "the managed entry is removed");
  const backups = readdirSync(pluginDir).filter((name) => name.startsWith(`${OPENCODE_PLUGIN_FILENAME}.37soul-`));
  assert.equal(backups.length, 1, "the modified file is backed up exactly once");
  assert.equal(readFileSync(path.join(pluginDir, backups[0]), "utf8"), "// user-modified\n", "the backup holds the modified content");

  h.cleanup();
});

test("uninstall: an unchanged OpenCode plugin is simply removed (no backup)", async () => {
  const h = harness({ fetch: opencodeDeviceFlow() });
  await install(h.deps, { agents: ["opencode"] });

  const pluginPath = openCodePluginPath(h.home);
  const pluginDir = openCodePluginDir(h.home);
  await uninstall(h.deps);

  assert.equal(statSync(pluginPath, { throwIfNoEntry: false }), undefined, "the managed entry is removed");
  const backups = readdirSync(pluginDir).filter((name) => name.startsWith(`${OPENCODE_PLUGIN_FILENAME}.37soul-`));
  assert.deepEqual(backups, [], "an unchanged file is removed without a backup");

  h.cleanup();
});

test("doctor: OpenCode plugin bridge reports a specific honest state", async () => {
  const h = harness({ fetch: opencodeDeviceFlow() });
  await install(h.deps, { agents: ["opencode"] });

  // The plugin file exists but OpenCode's own config has no load marker yet.
  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return { text: "brief" }; } });
  const report = await runDoctor({ ...h.deps, fetch: fetchImpl });
  const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

  const check = byName(report)["opencode: plugin bridge"];
  assert.ok(check, "the plugin bridge check is present");
  assert.equal(check.ok, false);
  assert.equal(check.detail, "plugin file present but OpenCode has not loaded it — add it to OpenCode's plugins");

  h.cleanup();
});

test("doctor: Codex hook reports an honest trust state, never a blanket ok", async () => {
  const h = harness();
  await install(h.deps, { agents: ["codex"] });

  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return { text: "brief" }; } });
  const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

  // The managed hook-config file exists, but Codex has not authorized it: the
  // doctor must say "not trusted", not the old `ok: true` hand-wave.
  const check = byName(await runDoctor({ ...h.deps, fetch: fetchImpl }))["codex: SessionStart hook"];
  assert.ok(check, "the codex SessionStart hook check is present");
  assert.equal(check.ok, false, "an untrusted Codex hook must not report ok");
  assert.equal(
    check.detail,
    "installed, not trusted — Codex has not authorized the hook (no `trusted = true` in its config.toml)",
  );

  // A Codex-authored trust marker flips trust green, but no SessionStart event
  // has been observed yet — trust is not observation, so the check stays not-ok.
  writeFileSync(path.join(h.home, ".codex", "config.toml"), "[hooks.37soul-hooks]\ntrusted = true\n", { mode: 0o600 });
  const trusted = byName(await runDoctor({ ...h.deps, fetch: fetchImpl }))["codex: SessionStart hook"];
  assert.equal(trusted.ok, false, "trust alone (no observed event) is not green");
  assert.equal(trusted.detail, "installed and trusted, but no SessionStart events observed yet");

  h.cleanup();
});

// ---------------------------------------------------------------------------
// Hermes (Task 9): the ONE managed static Python bridge — install records it by
// exact path + SHA-256, uninstall is hash-aware and never touches another
// vendor's plugin, and doctor reports the gateway-only surface explicitly.
// ---------------------------------------------------------------------------

function hermesDeviceFlow() {
  return deviceFlowFetch({ polls: [{ status: 201, body: { tokens: [{ agent_kind: "hermes", token: "TOKEN-HERMES" }] } }] });
}

test("install: records the managed Hermes bridge by exact path + SHA-256 and replaces only that entry", async () => {
  const h = harness({ fetch: hermesDeviceFlow() });

  // A pre-existing unrelated plugin file must survive install untouched.
  const pluginDir = hermesPluginDir(h.home);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "some-other-plugin.py"), "print('other vendor')\n", { mode: 0o600 });
  // A pre-existing file at OUR path gets backed up exactly once before replacement.
  writeFileSync(hermesPluginPath(h.home), "print('old bridge')\n", { mode: 0o600 });

  await install(h.deps, { agents: ["hermes"] });

  const manifest = JSON.parse(readFileSync(installManifestPath(h.home), "utf8"));
  const bridgeEntry = manifest.entries.find((entry) => entry.kind === "hermes_plugin");
  assert.ok(bridgeEntry, "the managed bridge file is recorded in the manifest");
  assert.equal(bridgeEntry.agent, "hermes");
  assert.equal(bridgeEntry.file, hermesPluginPath(h.home));
  assert.equal(bridgeEntry.sha256, hermesPluginSha256());

  // The installed file is exactly our source.
  assert.equal(readFileSync(hermesPluginPath(h.home), "utf8"), HERMES_PLUGIN_SOURCE);
  // The pre-existing file was backed up, and the other vendor's plugin untouched.
  const backups = readdirSync(pluginDir).filter((name) => name.startsWith(`${HERMES_PLUGIN_FILENAME}.37soul-`));
  assert.equal(backups.length, 1, "the pre-install file is backed up exactly once");
  assert.equal(readFileSync(path.join(pluginDir, backups[0]), "utf8"), "print('old bridge')\n");
  assert.equal(readFileSync(path.join(pluginDir, "some-other-plugin.py"), "utf8"), "print('other vendor')\n");

  h.cleanup();
});

test("install: reports the Hermes bridge as installed-but-unverified with surface", async () => {
  const h = harness({ fetch: hermesDeviceFlow() });

  const result = await install(h.deps, { agents: ["hermes"] });
  const hermesEntry = result.installed.find((entry) => entry.agentKind === "hermes");

  // No global hook / instructions / MCP: the bridge file is the only managed artifact.
  assert.equal(hermesEntry.hook, false);
  assert.equal(hermesEntry.instructions, false);
  assert.equal(hermesEntry.mcp, false);
  // Honest report: our own write never makes trust/events/extraction/injection green.
  // No `.hermes` config existed before install, so the detected surface is "none".
  assert.deepEqual(hermesEntry.report, {
    installed: true,
    trusted: false,
    events_seen: false,
    extraction_capable: false,
    injection_capable: false,
    surface: "none",
  });
  assert.ok(
    h.logs.some((line) => line.includes("hermes") && line.includes("trusted=pending") && line.includes("injection=no")),
    "the honest state line is logged",
  );

  h.cleanup();
});

test("uninstall: removes only the Hermes bridge entry and leaves other plugins", async () => {
  const h = harness({ fetch: hermesDeviceFlow() });

  const pluginDir = hermesPluginDir(h.home);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "some-other-plugin.py"), "print('other vendor')\n", { mode: 0o600 });

  await install(h.deps, { agents: ["hermes"] });
  assert.ok(statSync(hermesPluginPath(h.home), { throwIfNoEntry: false }), "our bridge file exists after install");

  const removed = await uninstall(h.deps);
  assert.ok(removed.some((entry) => entry.includes(HERMES_PLUGIN_FILENAME)), "the bridge file removal is reported");
  assert.equal(statSync(hermesPluginPath(h.home), { throwIfNoEntry: false }), undefined, "our bridge file is gone");
  assert.equal(readFileSync(path.join(pluginDir, "some-other-plugin.py"), "utf8"), "print('other vendor')\n", "another vendor's plugin survives");

  h.cleanup();
});

test("uninstall: a modified Hermes bridge is backed up before removal, never destroyed", async () => {
  const h = harness({ fetch: hermesDeviceFlow() });
  await install(h.deps, { agents: ["hermes"] });

  const bridgePath = hermesPluginPath(h.home);
  const pluginDir = hermesPluginDir(h.home);
  writeFileSync(bridgePath, "# user-modified\n", { mode: 0o600 });

  await uninstall(h.deps);

  assert.equal(statSync(bridgePath, { throwIfNoEntry: false }), undefined, "the managed entry is removed");
  const backups = readdirSync(pluginDir).filter((name) => name.startsWith(`${HERMES_PLUGIN_FILENAME}.37soul-`));
  assert.equal(backups.length, 1, "the modified file is backed up exactly once");
  assert.equal(readFileSync(path.join(pluginDir, backups[0]), "utf8"), "# user-modified\n", "the backup holds the modified content");

  h.cleanup();
});

test("uninstall: an unchanged Hermes bridge is simply removed (no backup)", async () => {
  const h = harness({ fetch: hermesDeviceFlow() });
  await install(h.deps, { agents: ["hermes"] });

  const bridgePath = hermesPluginPath(h.home);
  const pluginDir = hermesPluginDir(h.home);
  await uninstall(h.deps);

  assert.equal(statSync(bridgePath, { throwIfNoEntry: false }), undefined, "the managed entry is removed");
  const backups = readdirSync(pluginDir).filter((name) => name.startsWith(`${HERMES_PLUGIN_FILENAME}.37soul-`));
  assert.deepEqual(backups, [], "an unchanged file is removed without a backup");

  h.cleanup();
});

test("doctor: Hermes gateway-only reports explicitly, never as CLI", async () => {
  const h = harness({ fetch: hermesDeviceFlow() });

  // A gateway-only config exists before install: the surface is detected and the
  // doctor must say so instead of pretending the CLI can extract.
  mkdirSync(path.dirname(hermesConfigPath(h.home)), { recursive: true });
  writeFileSync(hermesConfigPath(h.home), `${JSON.stringify({ transport: "gateway", gateway: { url: "https://gateway.example" } })}\n`, { mode: 0o600 });

  await install(h.deps, { agents: ["hermes"] });

  const fetchImpl = async () => ({ ok: true, status: 200, async json() { return { text: "brief" }; } });
  const report = await runDoctor({ ...h.deps, fetch: fetchImpl });
  const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

  const check = byName(report)["hermes: plugin bridge"];
  assert.ok(check, "the plugin bridge check is present");
  assert.equal(check.ok, false);
  assert.equal(
    check.detail,
    "Hermes config declares a gateway-only surface — this is not a CLI model capability, so structured extraction stays off",
  );

  h.cleanup();
});

test("install: repeat install preserves scoped credentials, profile, Soul UUID and assets", async () => {
  const h = harness();
  const root = dataRoot(h.home);
  const profileId = "default";
  mkdirSync(path.join(root, "profiles", profileId), { recursive: true });
  writeFileSync(path.join(root, "profiles", profileId, "device.json"), `${JSON.stringify({ device_id: "dev-1" })}\n`, { mode: 0o600 });
  const store = await openStore(root, profileId);
  const soulUid = "10000000-0000-4000-8000-000000000001";
  const assetUid = "40000000-0000-4000-8000-000000000001";
  await store.transact((d) => {
    d.owner_id = "owner-1";
    d.cloud_device_uid = "cdu-1";
    d.souls[soulUid] = {
      soul_uid: soulUid, legacy_host_id: 42, identity_revision: 1,
      identity: { name: "Growth", description: "", character: "evidence first", greeting: "" },
      state: "active", origin: "local",
      local_identity: { name: "Growth", description: "", character: "evidence first", greeting: "" },
      local_identity_revision: 1,
    };
    d.assets[assetUid] = {
      asset_uid: assetUid, soul_uid: soulUid, kind: "relationship", trait: "preference",
      content: "keep me", applicability: "", tags: [], evidence: "explicit_user_statement",
      verification: "unverified", sensitivity: "normal", state: "active", revision: 1,
      supersedes_uid: null, pinned: false,
      source: { runtime_kind: "hermes", session_ref: "s", event_ref: "e", occurred_at: "2026-10-20T00:00:00Z" },
      sync_state: "synced", cloud_revision: 1,
    };
  });
  await store.close();
  const credentials = [{
    token: "scoped-token", owner_id: "owner-1", cloud_device_uid: "cdu-1",
    runtime_kind: "hermes", profile_id: profileId, obtained_at: "2026-10-20T00:00:00Z",
  }];
  await saveConfig(root, {
    api_base_url: "https://app.test",
    machine_id: "machine-1",
    tokens: { hermes: "scoped-token" },
    credentials,
  });

  const networkBefore = h.deps.fetch.calls.length;
  await install(h.deps, { agents: ["claude-code"] });
  assert.equal(h.deps.fetch.calls.length, networkBefore, "repeat install makes no cloud request");
  const config = await loadConfig(root);
  assert.deepEqual(config.credentials, credentials, "scoped credentials survive repeat install");
  assert.equal(config.machine_id, "machine-1");

  const afterStore = await openStore(root, profileId);
  const snap = await afterStore.read();
  await afterStore.close();
  assert.equal(snap.souls[soulUid].legacy_host_id, 42);
  assert.equal(snap.souls[soulUid].identity.character, "evidence first");
  assert.equal(snap.assets[assetUid].content, "keep me");
  h.cleanup();
});
