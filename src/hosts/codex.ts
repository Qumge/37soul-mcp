import path from "node:path";
import { editManagedFragment, removeManagedFragment } from "../config-editor.js";
import { stat } from "node:fs/promises";
import { inspectCodexTrust, removeCodexHookConfig, writeCodexHookConfig, codexHookConfigPath, CODEX_HOOK_EVENTS, createCodexAdapter, latestCodexCompletedTurnRefs } from "../adapters/codex.js";
import type { HostSpec, HostInstallDeps, HostInstallResult, HostDoctorDeps, HostDoctorCheck } from "./types.js";
import { parseHookPayload, readTextSafe, dirCheck } from "./shared.js";
import { INSTRUCTIONS_FRAGMENT } from "./instructions.js";

export function codexInstructionsPath(home: string): string {
  return path.join(home, ".codex", "AGENTS.md");
}

async function configureCodex(
  deps: HostInstallDeps,
  token: string,
): Promise<HostInstallResult> {
  // Codex 选 B 档（实测：hook 需要 trust 才执行，未端到端验证；设计 §6.4.1）：
  // 全局指令片段 + 一个 **stdio MCP server**。审查修复 2：实测 `codex mcp add --env`
  // 会把 token 直接写进 config.toml（`[mcp_servers.37soul.env]`），不需要用户再跑
  // `codex mcp login` —— 安装器用刚发好的那枚 token 一次写完，全程无感。
  //
  // Task 7：用真实的 hook/trust 面替代旧的「hook:false 就是没事」。我们写自己的
  // 订阅（installed）并检查 Codex 自己的 config 里的信任标记（trusted）——我们
  // 自己写的配置永远不能把 trusted/events/injection 变成绿。
  await editManagedFragment(codexInstructionsPath(deps.home), INSTRUCTIONS_FRAGMENT);
  writeCodexHookConfig(deps.home, { command: deps.launcher ?? "37soul" });
  const trust = inspectCodexTrust(deps.home);

  let mcp = false;
  // Anonymous-first assets-only install has no token: `codex mcp add --env
  // SOUL37_API_TOKEN=` with an empty value would register a broken stdio server.
  // Skip registration entirely until the user logs in on the website.
  if (deps.launcher && token) {
    const addArgs = [
      "codex",
      "mcp",
      "add",
      "37soul",
      "--env",
      `SOUL37_API_TOKEN=${token}`,
      // 启动器默认跑 cli.js；给 MCP server 换成 index.js。
      "--env",
      "SOUL37_ENTRY=dist/index.js",
      "--",
      deps.launcher
    ];
    try {
      let result = await deps.runCommand(addArgs);
      if (result.code !== 0) {
        // 重新安装时同名 server 已存在：先移除再写，等于刷新 token。
        await deps.runCommand(["codex", "mcp", "remove", "37soul"]).catch(() => {});
        result = await deps.runCommand(addArgs);
      }
      mcp = result.code === 0;
      if (!mcp) deps.log?.(`  codex mcp add did not succeed (${result.stderr || result.stdout}); add the MCP server by hand if you want resume/checkpoint.`);
    } catch (error) {
      deps.log?.(`  codex mcp add failed: ${(error as Error).message}`);
    }
  }

  return {
    manifestEntries: [
      { agent: "codex", file: codexInstructionsPath(deps.home), kind: "fragment" },
      { agent: "codex", file: codexHookConfigPath(deps.home), kind: "codex_hooks", events: CODEX_HOOK_EVENTS.map((entry) => entry.event) },
      { agent: "codex", file: path.join(deps.home, ".codex", "config.toml"), kind: "mcp" },
    ],
    hook: false, // legacy: no trusted/active hook has been observed
    instructions: true,
    mcp,
    report: {
      installed: true, // official hooks.json write, not proof of trust
      trusted: trust.trusted, // never fabricated; Codex owns its trust store
      events_seen: trust.events_seen,
      extraction_capable: false, // no verified native command (P0 未验)
      injection_capable: false, // do not claim injection until Codex shows trust/events
    },
  };
}

async function uninstall(deps: HostInstallDeps, removed: string[]): Promise<void> {
  const file = codexInstructionsPath(deps.home);
  const result = await removeManagedFragment(file).catch(() => ({ changed: false }));
  if (result.changed) removed.push(path.relative(deps.home, file));
  // 2b. Codex hook 订阅配置（我们管理的文件；真实 Codex hook 格式未验证）。
  if (removeCodexHookConfig(deps.home)) removed.push(path.relative(deps.home, codexHookConfigPath(deps.home)));
}

async function doctor(deps: HostDoctorDeps): Promise<HostDoctorCheck[]> {
  const agentKind = "codex";
  const checks: HostDoctorCheck[] = [];
  const instructions = await readTextSafe(codexInstructionsPath(deps.home));
  checks.push({ name: `${agentKind}: instructions`, ok: instructions.includes("37soul:begin"), detail: codexInstructionsPath(deps.home) });
  // Task 10: honest Codex hook result (replaces the old `ok:true` / "not used
  // (B tier)" hand-wave). installed / trusted / events_seen /
  // extraction_capable / injection_capable are the five report states; a write
  // we performed never makes trusted or events_seen green.
  let hookInstalled = false;
  try {
    hookInstalled = (await stat(codexHookConfigPath(deps.home))).isFile();
  } catch {
    hookInstalled = false;
  }
  const trust = inspectCodexTrust(deps.home);
  checks.push({
    name: `${agentKind}: SessionStart hook`,
    ok: trust.trusted && trust.events_seen,
    detail: codexHookDetail(hookInstalled, trust),
  });
  const sessions = path.join(deps.home, ".codex", "sessions");
  checks.push(await dirCheck(`${agentKind}: session records`, sessions));
  return checks;
}

function codexHookDetail(installed: boolean, trust: { trusted: boolean; events_seen: boolean }): string {
  if (!installed) return "not installed — run `37soul install`";
  if (trust.events_seen) return "hook events observed; Codex's persistent trust state is managed in /hooks";
  return "installed in .codex/hooks.json; Codex has not shown a trusted/observed hook — review with /hooks";
}

export const host: HostSpec = {
  kind: "codex",
  label: "Codex",
  home: ".codex",
  level: "full",
  hook: {
    events: CODEX_HOOK_EVENTS,
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseHookPayload,
    completedTurnRefs: (transcript) => latestCodexCompletedTurnRefs(transcript).refs,
  },
  install: {
    plan: ({ home }) => [codexInstructionsPath(home), codexHookConfigPath(home)],
    configure: configureCodex,
    uninstall,
    mcpRemoveCommands: [["codex", "mcp", "remove", "37soul"]],
  },
  doctor,
  invoke: { binary: "codex", createAdapter: createCodexAdapter },
};
