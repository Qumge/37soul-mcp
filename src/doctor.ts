/**
 * `37soul doctor`：逐个 Agent 检查配置在不在、token 还能不能用、会话目录能不能读、
 * 最近一次上传是什么时候。输出是给人看的；返回 ok=false 时 CLI 以非零退出。
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, loadState } from "./agentd/state.js";
import { claudeInstructionsPath, claudeSettingsPath, codexInstructionsPath, dataRoot, hookCommand, installManifestPath } from "./install.js";
import { inspectOpenCodePlugin } from "./adapters/opencode.js";
import { inspectHermesPlugin } from "./adapters/hermes.js";
import { spoolStats } from "./agentd/spool.js";
import { plistPath, systemdPath } from "./service.js";
import { readAccountsIndex } from "./local/profiles.js";
import { isAssetsModeSync } from "./sync/client.js";
import { openStore } from "./local/store.js";

export interface DoctorDeps {
  home: string;
  apiBase: string;
  fetch: typeof fetch;
  runCommand: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  nodePath: string;
  cliScriptPath: string;
  /** 和 install 用同一个平台判断（测试里注入 darwin，CI 跑在 Linux 上）。 */
  platform?: NodeJS.Platform;
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

  // Soul sync (assets-only mode) status: pending / conflict counts per local profile.
  // Read-only and non-fatal — the legacy capture path still runs alongside it.
  const assetsMode = isAssetsModeSync(root);
  if (assetsMode) {
    try {
      const index = await readAccountsIndex(root);
      let pending = 0;
      let conflicts = 0;
      for (const entry of Object.values(index)) {
        const store = await openStore(root, entry.profile_id);
        try {
          const snap = await store.read();
          pending += Object.keys(snap.outbox).length;
          conflicts += Object.keys(snap.quarantine).length;
        } finally {
          await store.close();
        }
      }
      checks.push({
        name: "soul sync",
        ok: true,
        detail: `assets_only mode — ${pending} pending change(s), ${conflicts} quarantined`,
      });
    } catch {
      checks.push({ name: "soul sync", ok: true, detail: "assets_only mode" });
    }
  }

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
    } else if (agentKind === "opencode") {
      // 插件桥（Task 8）：六个诚实状态，各自不同的 detail；没有一个状态是绿的
      // （observation_only 是上限，直到有授权的真机 probe）。ok 固定 false 且非 fatal。
      const inspection = inspectOpenCodePlugin(deps.home);
      checks.push({ name: `${agentKind}: plugin bridge`, ok: false, detail: openCodeDoctorDetail(inspection) });
    } else if (agentKind === "hermes") {
      // Python 桥（Task 9）：三个诚实状态；gateway-only 配置必须显式说出来，
      // 绝不冒充 CLI 能力。observation_only 是上限，直到有授权的真机 probe。
      const inspection = inspectHermesPlugin(deps.home);
      checks.push({ name: `${agentKind}: plugin bridge`, ok: false, detail: hermesDoctorDetail(inspection) });
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

  // 审查修复 1：hook 和后台服务都指向固定 runtime 的启动器 —— 这两条路径必须还在。
  const launcher = config.launcher;
  let launcherOk = false;
  if (launcher) {
    try {
      launcherOk = (await stat(launcher)).isFile();
    } catch {
      launcherOk = false;
    }
  }
  checks.push({
    name: "runtime: launcher",
    ok: launcherOk,
    detail: launcher
      ? launcherOk
        ? launcher
        : `${launcher} is missing — rerun \`37soul install\``
      : "not installed — rerun `37soul install`",
    fatal: !launcherOk,
  });

  // node 解析：记录路径失效时启动器会运行期换一个；doctor 替它先试一遍。
  const node = await resolveWorkingNode(config.node_path, deps.home);
  checks.push({
    name: "runtime: node",
    ok: Boolean(node),
    detail: node ?? "no working node found (set SOUL37_NODE or install Node)",
    fatal: !node,
  });

  // 服务文件（装了的话）必须存在、且引用的是固定启动器而不是 npx 缓存。
  const manifest = await readManifest(deps.home);
  if (manifest.entries.some((entry) => entry.kind === "service")) {
    const platform = deps.platform ?? process.platform;
    const serviceFile = platform === "darwin" ? plistPath(deps.home) : systemdPath(deps.home);
    const text = await readTextSafe(serviceFile);
    const ok = text.includes(launcher ?? "\u0000") && text.length > 0;
    checks.push({
      name: "runtime: service",
      ok,
      detail: ok ? serviceFile : text === "" ? `${serviceFile} is missing — rerun \`37soul install\`` : `${serviceFile} does not point at the runtime launcher`,
      fatal: !ok,
    });
  }

  // v2 §6.2/§6.1：hook 最近一次触发（spool 写入时间）、spool 积压量，以及
  // 「hook 长时间没动静」时的兜底提示。
  const spool = await spoolStats(root);
  checks.push({ name: "spool backlog", ok: true, detail: `${(spool.bytes / 1024).toFixed(1)} KB` });
  for (const agentKind of Object.keys(config.tokens)) {
    const stats = spool.agents[agentKind];
    const recent = Boolean(stats?.lastModifiedMs) && Date.now() - stats.lastModifiedMs < 24 * 3600 * 1000;
    checks.push({
      name: `${agentKind}: hook activity`,
      ok: recent,
      detail: stats?.lastModifiedMs ? `last event ${new Date(stats.lastModifiedMs).toISOString()}` : "no hook events yet",
    });
    if (!recent && !(config.transcript_fallback ?? []).includes(agentKind)) {
      checks.push({
        name: `${agentKind}: transcript fallback`,
        ok: true,
        detail: `hooks have not fired recently — enable with \`37soul install --agents ${agentKind} --fallback ${agentKind}\``,
      });
    }
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

/** 插件桥六状态 → 人话 detail；每个状态都是诚实的非绿（observation_only 是上限）。 */
function openCodeDoctorDetail(inspection: { status: string; declared: string }): string {
  switch (inspection.status) {
    case "not_installed":
      return "plugin bridge not installed — run `37soul install`";
    case "unsupported_generation":
      return `plugin bridge declares an unsupported generation (${inspection.declared || "none"}) — rerun \`37soul install\``;
    case "not_loaded":
      return "plugin file present but OpenCode has not loaded it — add it to OpenCode's plugins";
    case "not_trusted":
      return "plugin file present but OpenCode has not trusted it — approve it in OpenCode";
    case "model_refused":
      return "a live probe was refused by the model — no authorized probe yet";
    case "observation_only":
      return "events may be observed; no model call authorized (structured extraction stays off)";
    default:
      return inspection.status;
  }
}

/** Hermes Python 桥三状态 → 人话 detail；gateway-only 必须显式说不是 CLI。 */
function hermesDoctorDetail(inspection: { status: string; surface: string }): string {
  switch (inspection.status) {
    case "gateway_only":
      return "Hermes config declares a gateway-only surface — this is not a CLI model capability, so structured extraction stays off";
    case "not_installed":
      return "plugin bridge not installed — run `37soul install`";
    case "observation_only":
      return "events may be observed; no model call authorized (structured extraction stays off)";
    default:
      return inspection.status;
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

/** 启动器会按同样顺序试 node；doctor 只做无损探测，不执行 node。 */
async function resolveWorkingNode(recorded: string | undefined, home: string): Promise<string | null> {
  const candidates: string[] = [];
  if (recorded) candidates.push(recorded);
  // 与启动器一致：记录路径之后先看 PATH，再看 nvm / 常见安装位置。
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "node"));
  }
  try {
    const versions = (await readdir(path.join(home, ".nvm", "versions", "node"))).sort().reverse();
    candidates.push(...versions.map((version) => path.join(home, ".nvm", "versions", "node", version, "bin", "node")));
  } catch {
    // 没有 nvm
  }
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // 下一个
    }
  }
  return null;
}

async function readManifest(home: string): Promise<{ entries: Array<{ kind?: string }> }> {
  try {
    const parsed = JSON.parse(await readTextSafe(installManifestPath(home))) as { entries?: Array<{ kind?: string }> };
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}
