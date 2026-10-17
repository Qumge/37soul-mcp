/**
 * `37soul doctor`：逐个 Agent 检查配置在不在、token 还能不能用、会话目录能不能读、
 * 最近一次上传是什么时候。输出是给人看的；返回 ok=false 时 CLI 以非零退出。
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, loadState } from "./agentd/state.js";
import { claudeInstructionsPath, claudeSettingsPath, codexInstructionsPath, dataRoot, hookCommand } from "./install.js";

export interface DoctorDeps {
  home: string;
  apiBase: string;
  fetch: typeof fetch;
  runCommand: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  nodePath: string;
  cliScriptPath: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
  fatal?: boolean;
}

export async function runDoctor(deps: DoctorDeps): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [];
  const root = dataRoot(deps.home);
  const config = await loadConfig(root);

  if (!config) {
    checks.push({ name: "installation", ok: false, detail: "not installed — run `37soul install`", fatal: true });
    return { checks, ok: false };
  }
  checks.push({ name: "installation", ok: true, detail: `machine ${config.machine_id}` });

  for (const [agentKind, token] of Object.entries(config.tokens)) {
    // token 还能用（会顺手把 PAT 的 agent_kind 补上；这是免费读）
    const response = await deps.fetch(`${config.api_base_url}/api/v1/me/brief?agent_kind=${encodeURIComponent(agentKind)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    const tokenOk = response?.status === 200;
    checks.push({
      name: `${agentKind}: token`,
      ok: tokenOk,
      detail: tokenOk ? "accepted" : response ? `HTTP ${response.status}` : "no answer",
      fatal: !tokenOk,
    });

    // 配置痕迹
    if (agentKind === "claude-code") {
      const settings = await readTextSafe(claudeSettingsPath(deps.home));
      const hookPresent = settings.includes("hook --agent claude-code");
      checks.push({ name: `${agentKind}: SessionStart hook`, ok: hookPresent, detail: hookPresent ? hookCommand(deps, agentKind) : "missing" });
      const instructions = await readTextSafe(claudeInstructionsPath(deps.home));
      checks.push({ name: `${agentKind}: instructions`, ok: instructions.includes("37soul:begin"), detail: claudeInstructionsPath(deps.home) });
      checks.push({ name: `${agentKind}: mcp server`, ok: config.mcp?.[agentKind] === true, detail: config.mcp?.[agentKind] ? "registered" : "not registered — resume/checkpoint over MCP unavailable" });

      const projects = path.join(deps.home, ".claude", "projects");
      checks.push(await dirCheck(`${agentKind}: session records`, projects));
    } else if (agentKind === "codex") {
      const instructions = await readTextSafe(codexInstructionsPath(deps.home));
      checks.push({ name: `${agentKind}: instructions`, ok: instructions.includes("37soul:begin"), detail: codexInstructionsPath(deps.home) });
      checks.push({
        name: `${agentKind}: SessionStart hook`,
        ok: true,
        detail: "not used (B tier) — brief arrives via AGENTS.md + .37soul/brief.md",
      });
      const sessions = path.join(deps.home, ".codex", "sessions");
      checks.push(await dirCheck(`${agentKind}: session records`, sessions));
    }

    const state = await loadState(root);
    const lastUpload = Object.entries(state.sessions)
      .filter(([key]) => key.startsWith(`${agentKind}:`))
      .map(([, value]) => value.last_upload_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    checks.push({ name: `${agentKind}: last upload`, ok: Boolean(lastUpload), detail: lastUpload ?? "never (nothing captured yet)" });
  }

  const ok = checks.filter((check) => check.fatal).every((check) => check.ok);
  return { checks, ok };
}

async function readTextSafe(file: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function dirCheck(name: string, dir: string): Promise<DoctorCheck> {
  try {
    const info = await stat(dir);
    return { name, ok: info.isDirectory(), detail: dir };
  } catch {
    return { name, ok: false, detail: `${dir} (not found — has this agent run yet?)` };
  }
}
