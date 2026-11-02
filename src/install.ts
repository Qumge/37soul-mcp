/**
 * `37soul install`（设计 §6.1）：检测 → 设备码登录 → 写各 Agent 配置 → 装后台服务。
 *
 * 全部依赖注入（home / fetch / runCommand / 时钟 / sleep），测试用临时 home 与
 * fake 运行时驱动整条链路，不需要真的登录一次。
 */

import { chmod, cp, lstat, mkdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./config-editor.js";
import { installService, plistPath, removeService, systemdPath, type RunCommand, type ServiceSpec } from "./service.js";
import { configPath, emptyState, loadConfig, loadState, saveConfig, saveState, type AgentConfig } from "./agentd/state.js";
import { sendWriter, startWriter } from "./local/writer.js";
import { normalizeServerIssuer, sameServerIssuer } from "./agentd/server-identity.js";
import { readCredentials } from "./agentd/credentials.js";
import { readAccountsIndex } from "./local/profiles.js";
import { openStore } from "./local/store.js";
import "./local/bindings.js"; // side effect: register init_assets_profile (anonymous-first install)
import { HOSTS, hostSpec, SUPPORTED_AGENTS, AGENT_HOMES } from "./hosts/registry.js";
import type { HostInstallResult, CodexInstallReport, OpenCodeInstallReport, HermesInstallReport } from "./hosts/types.js";
export { INSTRUCTIONS_FRAGMENT, CLAUDE_HOOK_MATCHER } from "./hosts/instructions.js";
export { CLAUDE_HOOK_EVENTS, claudeSettingsPath, claudeInstructionsPath } from "./hosts/claude-code.js";
export { codexInstructionsPath } from "./hosts/codex.js";
export { hookCommand } from "./hosts/hook-command.js";
export type { CodexInstallReport, OpenCodeInstallReport, HermesInstallReport } from "./hosts/types.js";

export interface InstallDeps {
  home: string;
  apiBase: string;
  fetch: typeof fetch;
  runCommand: RunCommand;
  nodePath: string;
  cliScriptPath: string;
  agentdScriptPath: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** 交互选择；非交互环境默认全选检测到的。 */
  select?: (detected: string[]) => Promise<string[]>;
  /** 运行文件复制来源（含 dist/、package.json、node_modules/）；默认由 cliScriptPath 推断。 */
  runtimeSourceRoot?: string;
  /** 包版本，用来定 runtime 目录名；默认读 sourceRoot/package.json。 */
  runtimeVersion?: string;
  /** false = 设备码登录时不自动打开浏览器（测试 / 无图形界面）。 */
  openBrowser?: boolean;
  /** installRuntime 之后填上：固定 runtime 里的启动器路径。 */
  launcher?: string;
}

export interface InstalledAgent {
  agentKind: string;
  hook: boolean;
  instructions: boolean;
  mcp: boolean;
  /** Task 7/8/9: honest report for runtimes with unverified hooks/plugins (codex, opencode, hermes). */
  report?: CodexInstallReport | OpenCodeInstallReport | HermesInstallReport;
}

export interface InstallResult {
  installed: InstalledAgent[];
  skipped: string[];
  root: string;
}

export interface InstallPlan {
  detected: string[];
  agents: string[];
  files: string[];
  serviceFile: string | null;
  /** Detected hosts we cannot capture yet — callers must print these. */
  unsupported: string[];
}

export function installManifestPath(home: string): string {
  return path.join(dataRoot(home), "install-manifest.json");
}


/**
 * 被检测到、但我们还没有采集能力的宿主。
 *
 * 2026-10-30 之前这些宿主是**静默丢弃**的：`detectAgents` 认得 `~/.gemini`，
 * `planInstall` 却直接 filter 掉，不给任何提示 —— 装了 Gemini CLI 的人跑完
 * `37soul install` 会以为成功了。明确列出来并打印，比假装支持诚实。
 */
const KNOWN_UNSUPPORTED: Record<string, string> = {
  "gemini-cli": "detected, capture not implemented yet (tracked; MCP-only for now)",
};

/** v2 §6.1：`install --plan` 只打印要动哪些文件、装哪些 hook，不写入任何东西。 */
export async function planInstall(deps: InstallDeps, opts: { agents?: string[] } = {}): Promise<InstallPlan> {
  const detected = await detectAgents(deps.home);
  const agents = (opts.agents ?? detected).filter((kind) => SUPPORTED_AGENTS.includes(kind));
  const files: string[] = [];
  for (const host of HOSTS) {
    if (agents.includes(host.kind)) files.push(...host.install.plan(deps));
  }
  files.push(configPath(dataRoot(deps.home)), installManifestPath(deps.home));

  const runtimeMeta = await resolveRuntimeMeta(deps);
  const runtime = runtimeDir(deps.home, runtimeMeta.version);
  files.push(runtime, binLinkPath(deps.home));

  const platform = deps.platform ?? process.platform;
  const serviceFile = platform === "darwin" ? plistPath(deps.home) : platform === "linux" ? systemdPath(deps.home) : null;
  return {
    detected,
    agents,
    files,
    serviceFile,
    // 检测到但采集未实现：调用方必须打印出来，别让用户以为装上了。
    unsupported: detected.filter((kind) => !SUPPORTED_AGENTS.includes(kind)),
  };
}

async function resolveRuntimeMeta(deps: InstallDeps): Promise<{ sourceRoot: string; version: string }> {
  // tsc 产物在 <pkg>/dist/cli.js；发布包（install.sh 下载的 tarball）里跑的是
  // <pkg>/dist/bundle/cli.js —— 两种都要回到 <pkg>。
  const scriptDir = path.dirname(deps.cliScriptPath);
  const sourceRoot =
    deps.runtimeSourceRoot ?? (path.basename(scriptDir) === "bundle" ? path.dirname(path.dirname(scriptDir)) : path.dirname(scriptDir));
  let version = deps.runtimeVersion;
  if (!version) {
    try {
      version = (JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8")) as { version?: string }).version;
    } catch {
      version = undefined;
    }
  }
  if (!version) {
    try {
      const marker = JSON.parse(await readFile(path.join(sourceRoot, ".installed"), "utf8"));
      if (typeof marker.version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(marker.version)) version = marker.version;
    } catch {}
  }
  if (!version && path.basename(path.dirname(sourceRoot)) === "runtime" && /^\d+\.\d+\.\d+$/.test(path.basename(sourceRoot))) version = path.basename(sourceRoot);
  return { sourceRoot, version: version || "0.0.0" };
}

export async function detectAgents(home: string): Promise<string[]> {
  const detected: string[] = [];
  for (const [kind, dir] of Object.entries(AGENT_HOMES)) {
    try {
      await stat(path.join(home, dir));
      detected.push(kind);
    } catch {
      // 没装就没有
    }
  }
  return detected;
}

export function dataRoot(home: string): string {
  return path.join(home, ".37soul");
}

export function runtimeDir(home: string, version: string): string {
  return path.join(dataRoot(home), "runtime", version);
}

export function runtimeLauncher(home: string, version: string): string {
  return path.join(runtimeDir(home, version), "bin", "37soul");
}

/**
 * 把运行文件复制到固定位置 `~/.37soul/runtime/<version>/`（审查修复 1）：
 * npx 的 `~/.npm/_npx/<hash>/` 缓存会被清、nvm 的 node 路径换个版本就失效，
 * hook 和 launchd 都不能直接指向那里。启动器在**运行期**解析 node：
 * 先 PATH、再安装时记录的位置、再常见路径和 `~/.nvm/versions/node/*`，
 * 所以 node 升级也不会让 hook 报错。
 */
export async function installRuntime(deps: {
  home: string;
  sourceRoot: string;
  version: string;
  nodePath: string;
  log?: (line: string) => void;
}): Promise<{ dir: string; launcher: string; mode: "bundle" | "deps" }> {
  const dir = runtimeDir(deps.home, deps.version);
  const launcher = runtimeLauncher(deps.home, deps.version);
  const marker = path.join(dir, ".installed");

  try {
    const existing = JSON.parse(await readFile(marker, "utf8")) as { mode?: string };
    return { dir, launcher, mode: existing.mode === "deps" ? "deps" : "bundle" }; // 幂等
  } catch {
    // 没装过
  }

  // ⚠️ npm/npx 会把依赖提升到包目录之外（~/.npm/_npx/<hash>/node_modules），包目录里
  // 根本没有 node_modules —— 所以优先用 esbuild 打好的自包含 bundle（只有两个文件），
  // 复制失败必须报错，绝不能吞掉后留下一个起不来的 runtime。
  let bundleRoot = path.join(deps.sourceRoot, "dist", "bundle");
  // Installed releases flatten the two self-contained files into dist/ and
  // deliberately omit node_modules. Only a bundle marker authorizes this shape.
  try {
    const sourceMarker = JSON.parse(await readFile(path.join(deps.sourceRoot, ".installed"), "utf8"));
    if (sourceMarker.mode === "bundle" && !(await existsFile(path.join(bundleRoot, "cli.js")))) bundleRoot = path.join(deps.sourceRoot, "dist");
  } catch {}
  const bundleCli = path.join(bundleRoot, "cli.js");
  const bundleIndex = path.join(bundleRoot, "index.js");
  const hasBundle = (await existsFile(bundleCli)) && (await existsFile(bundleIndex));
  const hasDeps = await existsDirectory(path.join(deps.sourceRoot, "node_modules"));

  if (!hasBundle && !hasDeps) {
    throw new Error(
      `cannot install the 37soul runtime from ${deps.sourceRoot}: no dist/bundle (run \`npm run bundle\`) and no ` +
        "node_modules next to the package (npm/npx hoists dependencies outside the package directory). " +
        "Install a published build, or run from a checkout with `npm install && npm run build && npm run bundle`.",
    );
  }

  await mkdir(path.join(dir, "dist"), { recursive: true, mode: 0o700 });

  let mode: "bundle" | "deps";
  if (hasBundle) {
    mode = "bundle";
    // 只放两个自包含文件：不依赖外部模块，启动也更快。
    await cp(bundleCli, path.join(dir, "dist", "cli.js"));
    await cp(bundleIndex, path.join(dir, "dist", "index.js"));
  } else {
    mode = "deps";
    await cp(path.join(deps.sourceRoot, "dist"), path.join(dir, "dist"), { recursive: true, force: true });
    await cp(path.join(deps.sourceRoot, "node_modules"), path.join(dir, "node_modules"), { recursive: true, force: true });
  }

  // Node 18 (and every Node < 22) treats a `.js` file next to no package.json as
  // CommonJS, so an ESM bundle fails with "Cannot use import statement outside a
  // module". Ship a minimal `{"type":"module"}` marker so the launcher's cli.js /
  // index.js load as ESM on Node 18 exactly as they do on Node 20/22/24.
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module", version: deps.version })}\n`, { mode: 0o644 });

  await mkdir(path.dirname(launcher), { recursive: true, mode: 0o700 });
  await writeFile(launcher, launcherScript(deps.nodePath, dir), { mode: 0o755 });
  await chmod(launcher, 0o755);
  await writeFile(
    marker,
    `${JSON.stringify({ version: deps.version, mode, installed_at: new Date().toISOString(), node_path: deps.nodePath })}\n`,
    { mode: 0o600 },
  );
  deps.log?.(`  runtime installed at ${dir} (${mode})`);
  return { dir, launcher, mode };
}

export function launcherScript(recordedNode: string, runtimeRoot?: string): string {
  const escaped = recordedNode.replace(/'/g, "'\\''");
  // ⚠️ ROOT 写死成绝对路径：经 ~/.local/bin/37soul 这条软链调用时，BASH_SOURCE 是
  // 链接本身，按它推 ROOT 会推到 ~/.local。写死还顺便省掉每次 hook 两个子 shell。
  const rootLine = runtimeRoot
    ? `ROOT='${runtimeRoot.replace(/'/g, "'\\''")}'`
    : 'HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\nROOT="$(cd "$HERE/.." && pwd)"';
  return `#!/bin/bash
# 37soul runtime launcher —— 运行期解析 node：安装路径不随 nvm/npx 缓存失效。
# ⚠️ 只用 [ -x ] 判断可执行，绝不跑 "$NODE" -v：hook 每次调工具都会经过这里，
# 多起一次 node 就是每次多付 ~20ms。顺序：SOUL37_NODE → 安装时记录的 node
# → PATH → nvm/常见路径（记录优先，免得 PATH 上的老版本 node 抢在前面）。
set -euo pipefail
${rootLine}
ENTRY="\${SOUL37_ENTRY:-dist/cli.js}"
NODE="\${SOUL37_NODE:-}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then NODE='${escaped}'; fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then NODE="$(command -v node 2>/dev/null || true)"; fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "37soul: no working node found (set SOUL37_NODE, or install Node)" >&2
  exit 127
fi
exec "$NODE" "$ROOT/$ENTRY" "$@"
`;
}

/** `~/.local/bin/37soul`：让网页上写的 `37soul doctor` 这类命令直接能用。 */
export function binLinkPath(home: string): string {
  return path.join(home, ".local", "bin", "37soul");
}

/**
 * 指向固定 runtime 的启动器。只覆盖「不存在」或「本来就是我们的链接」——
 * 用户自己放在那里的同名文件绝不动。返回是否已经指向我们。
 */
export async function linkBin(home: string, launcher: string, log?: (line: string) => void): Promise<boolean> {
  const link = binLinkPath(home);
  await mkdir(path.dirname(link), { recursive: true });
  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink()) {
      log?.(`  ${link} already exists and is not ours; leaving it alone (run ${launcher} directly).`);
      return false;
    }
    const target = await readlink(link);
    if (!isOurRuntimePath(home, path.resolve(path.dirname(link), target))) {
      log?.(`  ${link} points somewhere else; leaving it alone (run ${launcher} directly).`);
      return false;
    }
    await unlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await symlink(launcher, link);
  return true;
}

function isOurRuntimePath(home: string, target: string): boolean {
  const runtimeRoot = path.join(dataRoot(home), "runtime") + path.sep;
  return target.startsWith(runtimeRoot);
}

async function unlinkBin(home: string): Promise<boolean> {
  const link = binLinkPath(home);
  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink()) return false;
    const target = await readlink(link);
    if (!isOurRuntimePath(home, path.resolve(path.dirname(link), target))) return false;
    await unlink(link);
    return true;
  } catch {
    return false;
  }
}

async function existsFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function existsDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** 设备码登录：拿码 → 让用户去浏览器 → 轮询换 token。 */
export interface DeviceLoginResult {
  tokens: Record<string, string>;
  /** §3 soul-assets/v1 fields; only present in assets mode. */
  protocol?: "soul-assets/v1";
  mode?: "assets_only";
  owner_id?: string;
  cloud_device_uid?: string;
  default_soul_uid?: string | null;
}

export interface DeviceLoginOptions {
  /**
   * §3 new-protocol login (`37soul login`). Sends protocol/mode/machine_id/
   * client_version and parses owner_id/cloud_device_uid/default_soul_uid. Defaults
   * to false so `install()` keeps its legacy behavior until Task 10 flips it.
   */
  assetsMode?: boolean;
  machineId?: string;
  clientVersion?: string;
}

export async function deviceLogin(
  deps: InstallDeps,
  agents: string[],
  options: DeviceLoginOptions = {},
): Promise<DeviceLoginResult> {
  const apiBase = normalizeServerIssuer(deps.apiBase);
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const assetsMode = options.assetsMode === true;

  if (assetsMode && !options.machineId) {
    throw new Error("assets login requires a stable machine_id");
  }

  // §3 adds only protocol/machine_id/client_version to the request; `mode` is
  // response-only (the server reports the assets mode it granted).
  const fields = assetsMode
    ? {
        protocol: "soul-assets/v1",
        machine_id: options.machineId,
        client_version: options.clientVersion ?? "0.0.0",
      }
    : {};

  const created = await deps.fetch(`${apiBase}/api/v1/cli/device_codes`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agents, ...fields }),
  });
  if (created.status !== 201) {
    throw new Error(`could not start the device login (HTTP ${created.status})`);
  }
  const device = (await created.json()) as {
    device_code: string;
    user_code: string;
    verification_url: string;
    interval?: number;
    expires_in?: number;
  };

  const approval = new URL(device.verification_url);
  const verificationUrl = `${apiBase}/cli/approve${approval.search}${approval.hash}`;
  log("");
  log(`  Open:  ${verificationUrl}`);
  log(`  Code:  ${device.user_code}`);
  log("");
  // 尽量替用户打开浏览器；打不开就靠上面那行链接（SSH、无图形界面时）。
  const opener = (deps.platform ?? process.platform) === "darwin" ? "open" : (deps.platform ?? process.platform) === "linux" ? "xdg-open" : null;
  if (opener && deps.openBrowser !== false) {
    await deps.runCommand([opener, verificationUrl]).catch(() => undefined);
  }

  const deadline = now() + (device.expires_in ?? 600) * 1000;
  for (;;) {
    const poll = await deps.fetch(`${apiBase}/api/v1/cli/tokens`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: device.device_code, agents, ...fields }),
    });

    if (poll.status === 201) {
      const body = (await poll.json()) as {
        protocol?: string;
        mode?: string;
        owner_id?: string;
        cloud_device_uid?: string;
        default_soul_uid?: string | null;
        tokens?: Array<{ agent_kind: string; token: string }>;
      };
      const tokens: Record<string, string> = {};
      // 只收我们请求过的 Agent：服务端理论上一字不差，本地再兜一层，
      // 免得将来协议漂移时把「没选中的身体」也配起来。
      for (const entry of body.tokens ?? []) {
        if (agents.includes(entry.agent_kind)) tokens[entry.agent_kind] = entry.token;
      }
      if (Object.keys(tokens).length === 0) throw new Error("the server approved nothing — run install again");
      return {
        tokens,
        protocol: body.protocol === "soul-assets/v1" ? "soul-assets/v1" : undefined,
        mode: body.mode === "assets_only" ? "assets_only" : undefined,
        owner_id: typeof body.owner_id === "string" ? body.owner_id : undefined,
        cloud_device_uid: typeof body.cloud_device_uid === "string" ? body.cloud_device_uid : undefined,
        default_soul_uid: typeof body.default_soul_uid === "string" ? body.default_soul_uid : null,
      };
    }
    if (poll.status === 202) {
      if (now() > deadline) throw new Error("the code expired before it was approved — run install again");
      await sleep((device.interval ?? 5) * 1000);
      continue;
    }
    if (poll.status === 410) throw new Error("the code expired — run install again");
    if ([400, 403, 404, 409, 422].includes(poll.status)) {
      throw new Error("the login was cancelled or the code was already used — run install again");
    }
    throw new Error(`device login failed (HTTP ${poll.status})`);
  }
}

/**
 * Anonymous-first install: establish the single anonymous assets profile and mark
 * the account index `assets_only` — through the single-writer IPC, exactly like
 * every other local soul mutation. Uses the running writer when one exists, else
 * starts a transient writer for the dispatch and closes it (the CLI process never
 * commits the snapshot itself).
 */
async function ensureAnonymousAssetsProfile(root: string): Promise<void> {
  const request = {
    request_uid: cryptoRandomId(),
    profile_id: "default",
    command: "init_assets_profile",
    payload: { profile_id: "default" },
  } as const;
  const direct = await sendWriter(root, request);
  if (direct.ok) return;
  if (direct.error.code !== "writer_unavailable") {
    throw new Error(`could not initialise the local assets profile: ${direct.error.message}`);
  }
  const writer = await startWriter(root).catch(() => null);
  if (!writer) {
    throw new Error("no writer is running — start agentd first");
  }
  try {
    const result = await sendWriter(root, request);
    if (!result.ok) {
      throw new Error(`could not initialise the local assets profile: ${result.error.message}`);
    }
  } finally {
    await writer.close().catch(() => {});
  }
}

export async function install(
  deps: InstallDeps,
  opts: { agents?: string[]; installService?: boolean; fallback?: string[] } = {},
): Promise<InstallResult> {
  const apiBase = normalizeServerIssuer(deps.apiBase);
  const log = deps.log ?? (() => {});
  const detected = await detectAgents(deps.home);
  const selected = (opts.agents ?? (deps.select ? await deps.select(detected) : detected)).filter((kind) =>
    SUPPORTED_AGENTS.includes(kind),
  );
  if (selected.length === 0) {
    throw new Error(`no supported agent selected (detected: ${detected.join(", ") || "none"})`);
  }

  const tokens: Record<string, string> = {};
  // Anonymous-first install (assets_only default): zero HTTP, no device login, no
  // tokens. The local assets profile becomes the write path; remote MCP reads stay
  // unavailable until the user logs in on the website and pairs a token.

  const root = dataRoot(deps.home);
  await ensureAnonymousAssetsProfile(root);
  const existing = (await loadConfig(root)) ?? null;

  // 审查修复 1：先把运行文件复制到固定 runtime，再写任何会长期存在的路径引用
  // （hook 配置、launchd/systemd、Codex 的 MCP 命令）。
  const runtimeMeta = await resolveRuntimeMeta(deps);
  const runtime = await installRuntime({
    home: deps.home,
    sourceRoot: runtimeMeta.sourceRoot,
    version: runtimeMeta.version,
    nodePath: deps.nodePath,
    log,
  });
  const runtimeDeps: InstallDeps = {
    ...deps,
    launcher: runtime.launcher,
    cliScriptPath: runtime.launcher,
    agentdScriptPath: runtime.launcher,
  };

  const config: AgentConfig = {
    api_base_url: apiBase,
    machine_id: existing?.machine_id ?? cryptoRandomId(),
    ...(existing?.active_profile_id !== undefined ? { active_profile_id: existing.active_profile_id } : {}),
    tokens: { ...(existing?.tokens ?? {}), ...tokens },
    // Repeat install must not drop the scoped credentials granted by login. A
    // fresh anonymous install starts with an empty array; existing data/profile
    // stays untouched because install never resets the asset store.
    credentials: existing?.credentials ?? [],
    installed_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
    mcp: { ...(existing?.mcp ?? {}) },
    // Assets mode: the legacy transcript fallback is inert (startAgentd forces an
    // empty fallback), so persisting one would be dead config. Keep it honest — no
    // fallback is recorded for an assets-only install.
    transcript_fallback: [],
    runtime_dir: runtime.dir,
    launcher: runtime.launcher,
    node_path: deps.nodePath,
  };
  await saveConfig(root, config);
  if (existing && !sameServerIssuer(existing.api_base_url, apiBase)) {
    log("Server changed; login required for this server (37soul login). Local data and issuer-bound credentials were preserved.");
  }

  const results: InstalledAgent[] = [];
  const configuredHosts = new Map<string, HostInstallResult>();
  for (const agentKind of selected) {
    const token = tokens[agentKind];
    const configured = await hostSpec(agentKind)!.install.configure(runtimeDeps, token);
    configuredHosts.set(agentKind, configured);
    config.mcp = { ...(config.mcp ?? {}), [agentKind]: configured.mcp };
    results.push({
      agentKind,
      hook: configured.hook,
      instructions: configured.instructions,
      mcp: configured.mcp,
      ...(configured.report ? { report: configured.report } : {}),
    });
    if (configured.report) {
      const r = configured.report;
      log(
        `  ${agentKind}: hook=no (untrusted) instructions=${configured.instructions ? "yes" : "no"} mcp=${configured.mcp ? "yes" : "no"} ` +
          `installed=yes trusted=${r.trusted ? "yes" : "pending"} events=${r.events_seen ? "yes" : "no"} ` +
          `extraction=${r.extraction_capable ? "yes" : "no"} injection=${r.injection_capable ? "yes" : "no"}`,
      );
    } else {
      log(`  ${agentKind}: hook=${configured.hook ? "yes" : "no (transcript fallback)"} instructions=yes mcp=${configured.mcp ? "yes" : "no"}`);
    }
  }
  await saveConfig(root, config);

  let serviceFile: string | null = null;
  if (opts.installService !== false && (deps.platform ?? process.platform) !== "win32") {
    const spec: ServiceSpec = {
      home: deps.home,
      nodePath: deps.nodePath,
      scriptPath: runtime.launcher,
      launcherPath: runtime.launcher,
      logPath: path.join(root, "agentd.log"),
      platform: deps.platform,
    };
    try {
      const service = await installService(spec, deps.runCommand);
      serviceFile = service.serviceFile;
      log(`  background capture installed (${service.serviceFile})`);
    } catch (error) {
      log(`  background capture could not be installed: ${(error as Error).message}`);
      log("  local capture stays off until the service runs; start it or run `37soul doctor` for the exact state.");
    }
  }

  const linked = await linkBin(deps.home, runtime.launcher, log).catch((error) => {
    log(`  could not link ${binLinkPath(deps.home)}: ${(error as Error).message}`);
    return false;
  });
  if (linked) log(`  command linked: ${binLinkPath(deps.home)}`);

  // v2 §6.1：把自己写了哪些文件、哪些键记进 manifest，供 doctor / uninstall 使用。
  const entries: Array<Record<string, unknown>> = [];
  entries.push({ file: runtime.dir, kind: "runtime", version: runtimeMeta.version });
  if (linked) entries.push({ file: binLinkPath(deps.home), kind: "bin_link" });
  // Installation follows selection order; manifest entries retain canonical host order.
  for (const host of HOSTS) {
    const configured = configuredHosts.get(host.kind);
    if (configured) entries.push(...configured.manifestEntries);
  }
  entries.push({ file: configPath(root), kind: "config" });
  if (serviceFile) entries.push({ file: serviceFile, kind: "service" });
  await writeJsonFile(
    installManifestPath(deps.home),
    { version: 1, updated_at: new Date(deps.now?.() ?? Date.now()).toISOString(), entries },
    0o600,
  );

  return {
    installed: results,
    skipped: detected.filter((kind) => !selected.includes(kind)),
    root,
  };
}

export async function uninstall(deps: InstallDeps): Promise<string[]> {
  const removed: string[] = [];
  const root = dataRoot(deps.home);

  for (const host of HOSTS) await host.install.uninstall(deps, removed);

  // MCP removal stays after every host's file cleanup, in registry order.
  for (const host of HOSTS) {
    for (const argv of host.install.mcpRemoveCommands ?? []) {
      try {
        await deps.runCommand([...argv]);
      } catch {
        // Runtime not installed: best effort, as before.
      }
    }
  }

  if (await unlinkBin(deps.home)) removed.push(path.relative(deps.home, binLinkPath(deps.home)));

  // 4. 后台服务 + 受管运行时文件。**绝不递归删整个 .37soul 数据根**：profiles/
  //（snapshot、备份、outbox、watermark、合并 journal、defaults）、accounts.json、
  // spool/（原始本地归档）与 queue/（未同步队列）都是用户资产，必须原样保留。
  // 只删安装器/agentd 自己管理的那几样：runtime/、ipc/、writer.lock、agentd.log、
  // install-manifest.json 与 config.json。
  await removeService(
    { home: deps.home, nodePath: deps.nodePath, scriptPath: deps.agentdScriptPath, logPath: "", platform: deps.platform },
    deps.runCommand,
  ).catch(() => {});
  for (const managed of ["runtime", "ipc"]) {
    const target = path.join(root, managed);
    let exists = false;
    try {
      await stat(target);
      exists = true;
    } catch {
      // 不存在：卸载幂等
    }
    if (!exists) continue;
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(path.join(".37soul", managed));
    } catch (error) {
      deps.log?.(`  could not remove .37soul/${managed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const managed of ["writer.lock", "agentd.log", "install-manifest.json", "config.json"]) {
    const target = path.join(root, managed);
    let exists = false;
    try {
      await stat(target);
      exists = true;
    } catch {
      // 不存在：卸载幂等
    }
    if (!exists) continue;
    try {
      await rm(target, { force: true });
      removed.push(path.join(".37soul", managed));
    } catch (error) {
      deps.log?.(`  could not remove .37soul/${managed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return removed;
}

export async function status(deps: InstallDeps): Promise<string[]> {
  const root = dataRoot(deps.home);
  const config = await loadConfig(root);
  const state = await loadState(root);
  const lines = [`machine: ${config?.machine_id ?? "(not installed)"}`];
  lines.push(`api: ${config?.api_base_url ?? "-"}`);
  lines.push(`paused: ${state.paused ? "yes" : "no"}${state.paused_repos?.length ? ` (${state.paused_repos.join(", ")})` : ""}`);
  for (const [kind, token] of Object.entries(config?.tokens ?? {})) {
    lines.push(`${kind}: token ${token ? "set" : "missing"}`);
  }
  const credentials = readCredentials(config).filter(credential => sameServerIssuer(credential.issuer, config?.api_base_url));
  lines.push(`sync credentials: ${credentials.length} scoped`);
  const accounts = await readAccountsIndex(root);
  const assetsProfiles = Object.values(accounts).filter((entry) => entry.soul_sync_mode === "assets_only");
  let pending = 0;
  let conflicts = 0;
  for (const entry of assetsProfiles) {
    try {
      const store = await openStore(root, entry.profile_id);
      try {
        const snap = await store.read();
        pending += Object.keys(snap.outbox).length;
        conflicts += Object.keys(snap.quarantine).length;
      } finally {
        await store.close();
      }
    } catch {
      // A corrupt/missing profile is reported by doctor; status stays readable.
    }
  }
  lines.push(
    credentials.length === 0
      ? `soul sync: login required (${assetsProfiles.length} local profile(s); local assets stay local)`
      : `soul sync: assets_only — ${pending} pending, ${conflicts} quarantined`,
  );
  // Legacy upload state is kept for old transcript-mode accounts only.
  const uploads = Object.entries(state.sessions ?? {}).filter(([, value]) => value.last_upload_at);
  if (uploads.length === 0) lines.push("legacy last upload: never");
  for (const [key, value] of uploads) lines.push(`legacy last upload ${key.split(":")[0]}: ${value.last_upload_at} (seq ${value.last_uploaded_seq})`);
  return lines;
}

export { loadState, saveState, emptyState, loadConfig, saveConfig, readJsonFile, writeJsonFile, stat, mkdir };

function cryptoRandomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `m-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
