import path from "node:path";
import { editJsonFile, editManagedFragment, removeManagedFragment } from "../config-editor.js";
import { CLAUDE_CODE_HOOK_EVENTS, createClaudeCodeAdapter, latestCompletedTurnSourceRefs } from "../adapters/claude-code.js";
import type { HostSpec, HostInstallDeps, HostInstallResult, HostDoctorDeps, HostDoctorCheck } from "./types.js";
import { parseHookPayload, readTextSafe, dirCheck } from "./shared.js";
import { INSTRUCTIONS_FRAGMENT } from "./instructions.js";
import { hookCommand } from "./hook-command.js";

export function claudeSettingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

export function claudeInstructionsPath(home: string): string {
  return path.join(home, ".claude", "CLAUDE.md");
}

export const CLAUDE_HOOK_EVENTS = CLAUDE_CODE_HOOK_EVENTS;

async function configureClaude(deps: HostInstallDeps, token: string): Promise<HostInstallResult> {
  const settings = claudeSettingsPath(deps.home);
  await editJsonFile(settings, (document) => {
    document.hooks = document.hooks ?? {};
    for (const { event, matcher } of CLAUDE_HOOK_EVENTS) {
      const list: any[] = Array.isArray(document.hooks[event]) ? document.hooks[event] : [];
      const own = (entry: any) =>
        Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("hook --agent claude-code"));
      const withoutOurs = list.filter((entry) => !own(entry));
      const entry: Record<string, any> = {
        hooks: [{ type: "command", command: hookCommand(deps, "claude-code", event), shell: "bash", async: false }]
      };
      if (matcher) entry.matcher = matcher;
      withoutOurs.push(entry);
      document.hooks[event] = withoutOurs;
    }
    return true;
  });

  const instructions = await editManagedFragment(claudeInstructionsPath(deps.home), INSTRUCTIONS_FRAGMENT);

  let mcp = false;
  // Anonymous-first assets-only install has no token: registering a remote MCP
  // server with an empty bearer header would only create a broken entry, and the
  // assets-mode read tools are unavailable without a login anyway. Skip it.
  if (token) {
    const addArgs = [
      "claude",
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "37soul",
      `${deps.apiBase}/mcp`,
      "--header",
      `Authorization: Bearer ${token}`,
    ];
    try {
      let result = await deps.runCommand(addArgs);
      if (result.code !== 0) {
        // 重新安装时同名 server 已存在：先移除再写。
        await deps.runCommand(["claude", "mcp", "remove", "--scope", "user", "37soul"]).catch(() => {});
        result = await deps.runCommand(addArgs);
      }
      mcp = result.code === 0;
      if (!mcp) deps.log?.(`  claude mcp add did not succeed (${result.stderr || result.stdout}); add the remote MCP server by hand if you want resume/checkpoint.`);
    } catch (error) {
      deps.log?.(`  claude mcp add failed: ${(error as Error).message}`);
    }
  }

  return {
    hook: true,
    instructions: instructions.changed || true,
    mcp,
    manifestEntries: [
      { agent: "claude-code", file: claudeSettingsPath(deps.home), kind: "hooks", events: CLAUDE_HOOK_EVENTS.map((entry) => entry.event) },
      { agent: "claude-code", file: claudeInstructionsPath(deps.home), kind: "fragment" },
    ],
  };
}

async function uninstall(deps: HostInstallDeps, removed: string[]): Promise<void> {
  // 1. Claude 的 hook 条目：只删命令里带我们标记的那一条。
  const settings = claudeSettingsPath(deps.home);
  try {
    // ⚠️ 每个事件都要清：只清 SessionStart 会把 PostToolUse 等条目留下来，指向
    // 已经删掉的 runtime —— 之后用户每调一次工具都会看到 hook 报错。
    const result = await editJsonFile(settings, (document) => {
      if (!document.hooks || typeof document.hooks !== "object") return false;
      let changed = false;
      for (const event of Object.keys(document.hooks)) {
        const list: any[] = Array.isArray(document.hooks[event]) ? document.hooks[event] : [];
        const keep = list.filter(
          (entry) => !(Array.isArray(entry?.hooks) && entry.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("hook --agent claude-code"))),
        );
        if (keep.length === list.length) continue;
        changed = true;
        if (keep.length === 0) delete document.hooks[event];
        else document.hooks[event] = keep;
      }
      if (changed && Object.keys(document.hooks).length === 0) delete document.hooks;
      return changed;
    });
    if (result.changed) removed.push("claude settings hook");
  } catch {
    // 配置文件坏了/不存在：不阻塞卸载
  }

  const file = claudeInstructionsPath(deps.home);
  const result = await removeManagedFragment(file).catch(() => ({ changed: false }));
  if (result.changed) removed.push(path.relative(deps.home, file));
}

async function doctor(deps: HostDoctorDeps): Promise<HostDoctorCheck[]> {
  const agentKind = "claude-code";
  const { config, assetsMode } = deps;
  const checks: HostDoctorCheck[] = [];
  const settings = await readTextSafe(claudeSettingsPath(deps.home));
  // 显示/比对的是 settings 里**应该**有的那条（指向固定 runtime 的启动器），
  // 不是当前进程的路径 —— 经 install.sh 安装时当前进程跑在一个马上会被删掉的临时目录里。
  const expected = hookCommand({ ...deps, launcher: config.launcher }, agentKind);
  const hookPresent = settings.includes("hook --agent claude-code");
  const hookCurrent = config.launcher ? settings.includes(JSON.stringify(expected).slice(1, -1)) : hookPresent;
  checks.push({
    name: `${agentKind}: SessionStart hook`,
    ok: hookPresent && hookCurrent,
    detail: !hookPresent ? "missing" : hookCurrent ? expected : "points at an old path — rerun `37soul install`",
  });
  const instructions = await readTextSafe(claudeInstructionsPath(deps.home));
  checks.push({ name: `${agentKind}: instructions`, ok: instructions.includes("37soul:begin"), detail: claudeInstructionsPath(deps.home) });
  if (!assetsMode) {
    checks.push({ name: `${agentKind}: mcp server`, ok: config.mcp?.[agentKind] === true, detail: config.mcp?.[agentKind] ? "registered" : "not registered — resume/checkpoint over MCP unavailable" });
  }

  const projects = path.join(deps.home, ".claude", "projects");
  checks.push(await dirCheck(`${agentKind}: session records`, projects));
  return checks;
}

export const host: HostSpec = {
  kind: "claude-code",
  label: "Claude Code",
  home: ".claude",
  level: "full",
  hook: {
    events: CLAUDE_HOOK_EVENTS,
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseHookPayload,
    completedTurnRefs: latestCompletedTurnSourceRefs,
  },
  install: {
    plan: ({ home }) => [claudeSettingsPath(home), claudeInstructionsPath(home)],
    configure: configureClaude,
    uninstall,
    mcpRemoveCommands: [["claude", "mcp", "remove", "--scope", "user", "37soul"]],
  },
  doctor,
  invoke: { binary: "claude", createAdapter: createClaudeCodeAdapter },
};
