/**
 * `37soul doctor`：本地检查运行时、宿主配置和 issuer/profile/owner/device 凭证范围。
 * 不发 HTTP、不验证服务端 token，不把历史 transcript 上传当作当前交付成功。
 */

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./agentd/state.js";
import { dataRoot, installManifestPath } from "./install.js";
import { hostSpec } from "./hosts/registry.js";
import { plistPath, systemdPath } from "./service.js";
import { readAccountsIndex, resolveLocalAssetsProfileSync } from "./local/profiles.js";
import { assertProfileCloudIssuer } from "./local/profile-issuer.js";
import { sameServerIssuer } from "./agentd/server-identity.js";
import { readCredentials, selectCredentials } from "./agentd/credentials.js";
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

  const localProfile = resolveLocalAssetsProfileSync(root);
  checks.push({
    name: "local profile",
    ok: localProfile !== null,
    detail: localProfile ? `active profile ${localProfile.profile_id}`
      : "No unambiguous valid local assets profile — run `37soul login` to complete recovery; existing local data is preserved",
    fatal: localProfile === null,
  });

  // soul-assets/v1 is the only protocol. Missing/corrupt metadata must never
  // revive legacy network probes or authorize a token from config.tokens.
  const assetsMode = true;
  const credentials: ReturnType<typeof readCredentials> = [];
  let pending = 0;
  let conflicts = 0;
  let unavailableProfiles = 0;
  const index = await readAccountsIndex(root);
  for (const [ownerId, entry] of Object.entries(index)) {
    // Reconnection leaves old data separate; its retained anonymous alias is
    // not the active website connection and cannot require another login.
    if (ownerId === "anonymous" && localProfile && entry.profile_id !== localProfile.profile_id) continue;
    if (entry.soul_sync_mode !== "assets_only") {
      unavailableProfiles += 1;
      continue;
    }
    try {
      const store = await openStore(root, entry.profile_id);
      try {
        const snap = await store.read();
        assertProfileCloudIssuer(snap, config.api_base_url, index);
        pending += Object.keys(snap.outbox).length;
        conflicts += Object.keys(snap.quarantine).length;
        const scoped = snap.owner_id === ownerId && sameServerIssuer(entry.cloud_issuer, config.api_base_url)
          ? selectCredentials(config, entry.profile_id, ownerId, snap.cloud_device_uid, config.api_base_url)
          : [];
        credentials.push(...scoped);
        if (scoped.length === 0) unavailableProfiles += 1;
      } finally {
        await store.close();
      }
    } catch {
      unavailableProfiles += 1;
    }
  }
  if (credentials.length === 0 || unavailableProfiles > 0) {
    notes.push(messages(deps.lang ?? detectLang()).bindingHint);
  }
  checks.push({
    name: "soul sync",
    ok: true,
    detail: credentials.length === 0
      ? "assets_only mode — login required; local assets stay local"
      : `assets_only mode — ${pending} pending change(s), ${conflicts} quarantined; ${credentials.length} locally scoped credential(s) (not server-validated)${unavailableProfiles > 0 ? `; login required for ${unavailableProfiles} profile(s)` : ""}`,
  });

  if(localProfile){
    const store=await openStore(root,localProfile.profile_id);
    try{const snap=await store.read();const pendingMemory=Object.values(snap.extraction_watermarks).filter(w=>!w.completed);
      const stale=pendingMemory.filter(w=>!Object.values(snap.bindings).some(b=>!b.retired&&b.state==="bound"&&b.binding_uid===w.request.binding_uid&&b.revision===w.request.binding_revision)).length;
      const usage=snap.extraction_usage?.[new Date().toISOString().slice(0,10)];const n=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:0;
      checks.push({name:"memory resources",ok:true,detail:`${pendingMemory.length} pending, ${stale} stale_binding retained; today ${n(usage?.calls)}/40 native calls, reserved_units ${n(usage?.reserved_units)}/200000; ordinary work batches at 3 turns or about 90–120s`});
    }catch{checks.push({name:"memory resources",ok:true,detail:"resource accounting unavailable; existing local data is preserved"});}
    finally{await store.close();}
  }

  // Iterate over every *installed* agent (from the manifest), not over tokens:
  // anonymous-first install has no tokens, but the hook/plugin state must still be
  // reported honestly. Legacy token keys identify diagnostics only, never auth.
  const manifest = await readManifest(deps.home);
  const manifestAgents = new Set<string>();
  for (const entry of manifest.entries) {
    if (typeof entry.agent === "string" && entry.agent !== "") manifestAgents.add(entry.agent);
  }
  const agents = [...new Set([...Object.keys(config.tokens), ...manifestAgents, ...readCredentials(config).map(credential => credential.runtime_kind)])];

  for (const agentKind of agents) {
    const scoped = credentials.some(credential => credential.runtime_kind === agentKind);
    checks.push({
      name: `${agentKind}: sync credential`,
      ok: scoped,
      detail: scoped
        ? "locally scoped to this server, profile, owner, device and runtime (not server-validated)"
        : "not available — run `37soul login`",
    });

    // Host-specific checks stay in this exact place in the per-agent report.
    const host = hostSpec(agentKind);
    if (host) checks.push(...await host.doctor({ ...deps, config, assetsMode }));


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

  // Raw spool is a historical archive, never current host delivery evidence.

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
