/**
 * `37soul doctor`：逐个 Agent 检查配置在不在、token 还能不能用、会话目录能不能读、
 * 最近一次上传是什么时候。输出是给人看的；返回 ok=false 时 CLI 以非零退出。
 */

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig, loadState } from "./agentd/state.js";
import { dataRoot, installManifestPath } from "./install.js";
import { hostSpec } from "./hosts/registry.js";
import { spoolStats } from "./agentd/spool.js";
import { plistPath, systemdPath } from "./service.js";
import { readAccountsIndex } from "./local/profiles.js";
import { readCredentials } from "./agentd/credentials.js";
import { isAssetsModeSync } from "./sync/client.js";
import { detectLang, messages, type Lang } from "./i18n.js";
import { openStore } from "./local/store.js";
import { inspectRuntime, type RuntimeHealth } from "./runtime-health.js";

export interface DoctorDeps {
  home: string;
  apiBase: string;
  fetch: typeof fetch;
  runCommand: (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  nodePath: string;
  cliScriptPath: string;
  /** 和 install 用同一个平台判断（测试里注入 darwin，CI 跑在 Linux 上）。 */
  platform?: NodeJS.Platform;
  /** 用户可见文案的语言；默认按进程的 locale 环境变量判断。 */
  lang?: Lang;
  inspectRuntime?: (root: string) => Promise<RuntimeHealth>;
  runtimeWaitMs?: number;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
  fatal?: boolean;
  /**
   * 既不是成功也不是失败，而是「还没发生」或「需要宿主自己动作」。
   * 2026-10-31 走查：全新的安装会用 ✗ 报 `hook activity — no hook events yet`，
   * 新手会当成装失败了。waiting 用「…」渲染。
   */
  waiting?: boolean;
}

export async function runDoctor(deps: DoctorDeps): Promise<{ checks: DoctorCheck[]; ok: boolean; notes: string[] }> {
  const checks: DoctorCheck[] = [];
  const notes: string[] = [];
  const root = dataRoot(deps.home);
  const config = await loadConfig(root);

  if (!config) {
    checks.push({ name: "installation", ok: false, detail: "not installed — run `37soul install`", fatal: true });
    return { checks, ok: false, notes };
  }
  checks.push({ name: "installation", ok: true, detail: `machine ${config.machine_id}` });

  // Soul sync (assets-only mode) status: pending / conflict counts per local profile.
  // Read-only and non-fatal — the legacy capture path still runs alongside it.
  const assetsMode = isAssetsModeSync(root);

  // 匿名安装（assets-only 且还没有 scoped credential）在 doctor 末尾给一句轻提示：
  // 绑定到 37soul.com 才能跨设备。已登录的人不再被念。
  const credentials = readCredentials(config);
  if (assetsMode && credentials.length === 0) {
    notes.push(messages(deps.lang ?? detectLang()).bindingHint);
  }

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
        detail: credentials.length === 0
          ? "assets_only mode — login required; local assets stay local"
          : `assets_only mode — ${pending} pending change(s), ${conflicts} quarantined`,
      });    } catch {
      checks.push({ name: "soul sync", ok: true, detail: "assets_only mode" });
    }
  }

  // Iterate over every *installed* agent (from the manifest), not over tokens:
  // anonymous-first install has no tokens, but the hook/plugin state must still be
  // reported honestly. The token check only runs when that agent has a token.
  const manifest = await readManifest(deps.home);
  const manifestAgents = new Set<string>();
  for (const entry of manifest.entries) {
    if (typeof entry.agent === "string" && entry.agent !== "") manifestAgents.add(entry.agent);
  }
  const agents = [...new Set([...Object.keys(config.tokens), ...manifestAgents])];

  for (const agentKind of agents) {
    const token = config.tokens[agentKind];
    if (assetsMode && (token || manifestAgents.has(agentKind))) {
      // Assets mode never calls the legacy /brief writeback. The useful state is
      // whether this runtime has a scoped credential for this profile/device.
      const scoped = readCredentials(config).some((credential) => credential.runtime_kind === agentKind);
      checks.push({
        name: `${agentKind}: sync credential`,
        ok: scoped,
        detail: scoped ? "scoped to this profile, owner, device and runtime" : "not available — run `37soul login`",
      });
    }
    if (token && !assetsMode) {
      // Legacy transcript mode only: token 还能用（会顺手把 PAT 的 agent_kind 补上；这是免费读）
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
    }

    // Host-specific checks stay in this exact place in the per-agent report.
    const host = hostSpec(agentKind);
    if (host) checks.push(...await host.doctor({ ...deps, config, assetsMode }));

    const state = await loadState(root);
    const lastUpload = Object.entries(state.sessions)
      .filter(([key]) => key.startsWith(`${agentKind}:`))
      .map(([, value]) => value.last_upload_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    if (!assetsMode) {
      checks.push({ name: `${agentKind}: last upload`, ok: Boolean(lastUpload), detail: lastUpload ?? "never (nothing captured yet)" });
    }
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

  // Observe the actual daemon even when service registration failed and no
  // service entry was written. A transient CLI writer is not the background job.
  let health = await (deps.inspectRuntime ?? inspectRuntime)(root);
  const deadline = Date.now() + (deps.runtimeWaitMs ?? 0);
  while ((!health.ok || !health.agentd) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    health = await (deps.inspectRuntime ?? inspectRuntime)(root);
  }
  const backgroundRunning = health.ok && health.agentd === true;
  checks.push({ name: "runtime: agentd", ok: backgroundRunning,
    detail: backgroundRunning ? `responding via IPC (pid ${health.pid})` : `${health.detail ?? "background agentd is not running"} — run \`37soul install\` or start \`37soul agentd\``, fatal: !backgroundRunning });

  // 服务文件（装了的话）必须存在、且引用的是固定启动器而不是 npx 缓存。
  if (manifest.entries.some((entry) => entry.kind === "service")) {
    const platform = deps.platform ?? process.platform;
    const serviceFile = platform === "darwin" ? plistPath(deps.home) : systemdPath(deps.home);
    const text = await readTextSafe(serviceFile);
    const configured = text.includes(launcher ?? "\u0000") && text.length > 0;
    const ok = configured && health.ok && health.agentd === true;
    checks.push({
      name: "runtime: service",
      ok,
      detail: !configured ? text === "" ? `${serviceFile} is missing — rerun \`37soul install\`` : `${serviceFile} does not point at the runtime launcher`
        : health.ok && health.agentd ? `${serviceFile}; agentd pid ${health.pid}` : `${serviceFile}; ${health.detail ?? "background agentd is not running"} — run \`37soul install\` or start \`37soul agentd\``,
      fatal: !ok,
    });
  }
  if (backgroundRunning) {
    const actual = path.dirname(path.dirname(path.resolve(health.entrypoint!)));
    const expected = config.runtime_dir ?? (launcher ? path.dirname(path.dirname(launcher)) : "");
    const canonical = async (dir: string) => realpath(dir).catch(() => path.resolve(dir));
    const matches = expected !== "" && await canonical(actual) === await canonical(expected);
    checks.push({ name: "runtime: running version", ok: matches,
      detail: matches ? `running ${path.basename(actual)} (pid ${health.pid})` : `running ${actual}; expected ${expected} — rerun \`37soul install\` to restart the service`, fatal: !matches });
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
      // 还没用过不是失败：标成等待态，等这个 Agent 真的被用起来才会变绿。
      ok: recent,
      waiting: !recent,
      detail: stats?.lastModifiedMs
        ? `last event ${new Date(stats.lastModifiedMs).toISOString()}`
        : "no events yet — normal until you use this agent",
    });
    if (!assetsMode && !recent && !(config.transcript_fallback ?? []).includes(agentKind)) {
      checks.push({
        name: `${agentKind}: transcript fallback`,
        ok: true,
        detail: `hooks have not fired recently — enable with \`37soul install --agents ${agentKind} --fallback ${agentKind}\``,
      });
    }
  }

  const ok = checks.filter((check) => check.fatal).every((check) => check.ok);
  return { checks, ok, notes };
}

async function readTextSafe(file: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(file, "utf8");
  } catch {
    return "";
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

async function readManifest(home: string): Promise<{ entries: Array<{ kind?: string; agent?: string }> }> {
  try {
    const parsed = JSON.parse(await readTextSafe(installManifestPath(home))) as { entries?: Array<{ kind?: string; agent?: string }> };
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}
