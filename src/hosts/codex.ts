import path from "node:path";
import { editManagedFragment, removeManagedFragment } from "../config-editor.js";
import { removeCodexHookConfig, codexHookConfigPath, CODEX_HOOK_EVENTS, createCodexAdapter, latestCodexCompletedTurnRefs } from "../adapters/codex.js";
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
  // Codex commands expose the exact native thread ID. The installer supplies
  // guidance; connect validates that rollout and agentd observes bound turns.
  // No hook or native trust setting is installed/approved on the user's behalf.
  await editManagedFragment(codexInstructionsPath(deps.home), INSTRUCTIONS_FRAGMENT + `
Codex: use 37soul connect --name NAME or --host ID directly. The local runtime reads
CODEX_THREAD_ID and verifies this exact native rollout; hook approval is not required.
After compaction, use 37soul context once to restore this session's selected Soul.
Do not query context on every ordinary turn or infer a Soul from another session.`);
  removeCodexHookConfig(deps.home);
  deps.log?.("  codex: local native-session bridge (no 37Soul hook approval required)");

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
      { agent: "codex", file: path.join(deps.home, ".codex", "config.toml"), kind: "mcp" },
    ],
    hook: false, // legacy: no trusted/active hook has been observed
    instructions: true,
    mcp,

  };
}

async function uninstall(deps: HostInstallDeps, removed: string[]): Promise<void> {
  const file = codexInstructionsPath(deps.home);
  const result = await removeManagedFragment(file).catch(() => ({ changed: false }));
  if (result.changed) removed.push(path.relative(deps.home, file));
  // 2b. Codex hook 订阅配置（我们管理的文件；真实 Codex hook 格式未验证）。
  if (removeCodexHookConfig(deps.home)) removed.push(path.relative(deps.home, codexHookConfigPath(deps.home)));
}

async function doctor(deps: HostDoctorDeps): Promise<Array<HostDoctorCheck & { waiting?: boolean }>> {
  const instructions = await readTextSafe(codexInstructionsPath(deps.home));
  const sessions = path.join(deps.home, ".codex", "sessions");
  return [
    {name: "codex: instructions", ok: instructions.includes("37soul:begin"), detail: codexInstructionsPath(deps.home)},
    {name: "codex: local session bridge", ok: instructions.includes("CODEX_THREAD_ID"), detail: "No 37Soul hook approval required. Connect reads Codex's native session ID and verifies its exact local rollout. Background capture starts only after explicit connection; installation alone does not prove model adoption or completed extraction."},
    await dirCheck("codex: session records", sessions),
  ];
}

export const host: HostSpec = {
  kind: "codex",
  label: "Codex",
  home: ".codex",
  hook: {
    events: CODEX_HOOK_EVENTS,
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseHookPayload,
    completedTurnRefs: (transcript) => latestCodexCompletedTurnRefs(transcript).refs,
  },
  install: {
    plan: ({ home }) => [codexInstructionsPath(home)],
    configure: configureCodex,
    uninstall,
    mcpRemoveCommands: [["codex", "mcp", "remove", "37soul"]],
  },
  doctor,
  invoke: { binary: "codex", userLaunchers: [".local/bin/codex", ".npm-global/bin/codex"], createAdapter: createCodexAdapter },
};
