#!/usr/bin/env node
import {codexEnvironmentSession, findCodexRollout} from './agentd/codex-native.js';
import {captureSourcePointer} from './agentd/source-index.js';
import {ownedHosts} from './local/cloud-account.js';
import {configureCloudSelectionHttp} from './local/cloud-selection.js';
import {sessionSourceBoundary} from './agentd/source-index.js';
import {readLocalIdentity,prepareLocalIdentity} from './local/agent-connect.js';
import {compactConnectionIdentity,localReadCapabilities} from './local/compact-identity.js';
import {readAvatarFile} from './local/avatars.js';
/**
 * `37soul` CLI（设计 §6.1）：install / doctor / status / uninstall / pause / resume，
 * 以及两个内部命令 `agentd`（后台采集进程）和 `hook --agent <kind>`（SessionStart）。
 *
 * npm 发布是独立的一步：在包名发布完成之前，本地用 `node dist/cli.js ...` 调用。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "./agentd/daemon.js";
import { createExtractAdapters, type NativeInvokerLog } from "./agentd/native-invoker.js";
import { createRotatingLogger } from "./agentd/logger.js";
import { emptyState, loadConfig, loadState, saveState } from "./agentd/state.js";
import { requireCloudIssuer, assertLoginProfileIssuers } from "./local/profile-issuer.js";
import { sameServerIssuer } from "./agentd/server-identity.js";
import { saveLoginCredentials } from "./agentd/credentials.js";
import { getGitState } from "./agentd/git-state.js";
import { repoKey } from "./repo-key.js";
import { deviceLogin, install, planInstall, status as statusReport, uninstall, type InstallDeps } from "./install.js";
import { runDoctor } from "./doctor.js";
import { detectLang, messages } from "./i18n.js";
import { runHookCommand } from "./hook.js";
import { startWriter, sendWriter, type WriterCommand, type WriterResult } from "./local/writer.js";
import { resolveLocalAssetsProfileSync } from "./local/profiles.js";
import { openStore, profilesDir, snapshotPath, StoreError } from "./local/store.js";
import {selectContext} from "./assets/context.js";
import {ownerContextInput} from "./sync/client.js";
import {bindingKey} from "./local/bindings.js";
import { setAccountDefaultSoul, setToolDefault, validatePublicProfile } from "./local/bindings.js";
import type { HttpFetch, ProfileId, RuntimeAdapter } from "./adapters/types.js";
import type { RuntimeKind } from "./assets/protocol.js";
import { RUNTIME_KINDS } from "./assets/protocol.js";
import { formatRecallHit, parseTerms, recallAssets } from "./assets/recall.js";
import "./local/bindings.js"; // side effect: register create_soul / edit_local_identity / bind / detach / export
import "./extraction/scheduler.js"; // side effect: register runtime_event / commit_extraction writer commands
import "./sync/client.js"; // side effect: register sync_once / record_receipt / review_asset / delete_asset
import { configureSyncHttp, isAssetsModeSync } from "./sync/client.js";
import { runSync, runSyncProfiles } from "./sync/run.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
  confirm?: (message: string) => Promise<boolean>;
}

/**
 * The assets-mode extract-adapter wiring used by `startAgentd`, extracted so a test
 * can pin the gate without running the resident daemon loop (intervals / fs.watch /
 * signal exit). Assets mode gets the real runtime adapters + spawn NativeInvoker
 * (whose readSource resolves event refs through the local path-pointer index);
 * accounts without assets metadata get `undefined`; raw uploads are always retired.
 */
export function agentdExtractAdapters(
  home: string,
  assetsMode: boolean,
  logger: NativeInvokerLog,
  root: string,
): Partial<Record<RuntimeKind, RuntimeAdapter>> | undefined {
  return assetsMode ? createExtractAdapters(home, logger, root) : undefined;
}

const USAGE = `37soul — local capture + continuity for your 37Soul character.

  37soul install [--agents claude-code,codex,opencode,hermes,pi,gemini-cli,cursor,kiro] [--plan] [--fallback codex]
                                                connect the agents on this machine
  37soul doctor                                  check configuration and credentials
  37soul status                                  show machine, credentials and Soul sync state
  37soul pause [--repo <path|repo-key>]          pause capture (all, or one repo)
  37soul resume                                  resume capture
  37soul uninstall                               remove managed hooks/service; keep profiles and raw archives

  37soul login [--host <id>] [--profile <id>]                  login to your account; choose a Soul later in your Agent
  37soul hosts [--name <name>] [--limit <n>] [--offset <n>]   list your owned Souls
  37soul whoami --host <id> [--agent <kind>]    read profile, recent life, public media and circle using this login
  37soul connect --name <name>|--host <id> [--agent <kind> --session <native-id>]   Codex resolves its native session automatically
  37soul context                               restore this Codex session’s selected Soul locally
  37soul sync [--profile <id>]                   push/pull the active profile, or an explicit profile
  37soul sync --all-profiles                    sync all cloud accounts; anonymous local profiles are skipped
                                                profile commands default to the valid active profile
  37soul soul create --name <n> --sex <male|female|other> --age <16-65> --character <50+ chars> --avatar <path> [--profile <id>]
  37soul soul list [--profile <id>]              list local Souls
  37soul recall [--soul <uid>|--host <id>|--name <exact name>|--all] [--profile <id>] [--history] [--kind relationship|experience] [--limit <1-100>] [--] [terms...]
                                                print local memories; one Soul auto-selects, multiple require a choice
                                                --all labels every hit with its Soul name and UID; terms use AND, default limit 10
  37soul soul select <uid> [--agent <kind>] [--profile <id>]   set the default Soul
  37soul soul edit <uid> [--name <n> ...] [--avatar <path>] [--profile <id>]   edit a local (unregistered) Soul
  37soul soul authorize <uid> [--categories identity,relationship,experience] [--profile <id>]
                                                explicitly authorize sync; profile is public, chats/memories are not
  37soul soul avatar <uid> --file <image> [--profile <id>]   upload a chosen avatar after login
  37soul soul export [--profile <id>]            export the owner-private core identity
  37soul soul review <uid> --approve|--reject [--profile <id>]   approve/reject a pending asset (interactive)
  37soul soul delete <uid> [--profile <id>]      delete an asset (interactive)
  37soul bind --soul <uid> --session <native-id> [--agent <kind>] [--profile <id>]
  37soul detach --session <native-id> [--agent <kind>] [--profile <id>]
`;

export function defaultHookRenderer(io: CliIO, argv: string[]): (text: string) => void {
  const isHook = argv[0] === "hook";
  return isHook ? (text: string) => io.stdout(text) : (text: string) => io.stdout(`${text}\n`);
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const home = process.env.SOUL37_HOME || os.homedir();
  const config = await loadConfig(path.join(home, ".37soul"));
  const apiBase = (process.env.SOUL37_BASE_URL || config?.api_base_url || "https://37soul.com").replace(/\/+$/, "");
  const cliScriptPath = fileURLToPath(import.meta.url);
  const deps = {
    home,
    apiBase,
    fetch: globalThis.fetch,
    runCommand: runCommandReal,
    nodePath: process.execPath,
    cliScriptPath,
    agentdScriptPath: cliScriptPath,
    platform: process.platform,
    log: (line: string) => io.stdout(`${line}\n`),
  };

  const [command, ...rest] = argv;
  const root = path.join(home, ".37soul");
  // Composition root: the sync writer command's transport is injected here (and in
  // startAgentd), never read from `globalThis.fetch` inside the writer.
  configureSyncHttp(globalThis.fetch as HttpFetch);
  configureCloudSelectionHttp(globalThis.fetch);
  switch (command) {
    case "install": {
      const agents = flagValue(rest, "--agents")?.split(",").map((s) => s.trim()).filter(Boolean);
      const fallback = flagValue(rest, "--fallback")?.split(",").map((s) => s.trim()).filter(Boolean);
      // v2 §6.1：--plan 只打印要动哪些文件，不写入任何东西。
      if (rest.includes("--plan")) {
        const plan = await planInstall(deps, { agents });
        io.stdout(`would connect: ${plan.agents.join(", ") || "(none detected)"}\n`);
        if (plan.unsupported.length > 0) {
          io.stdout(`detected but not capturable yet: ${plan.unsupported.join(", ")}\n`);
        }
        io.stdout(`would touch:\n${plan.files.map((file) => `  ${file}`).join("\n")}\n`);
        if (plan.serviceFile) io.stdout(`would install the background service: ${plan.serviceFile}\n`);
        if (plan.proxy.length > 0) io.stdout(`would persist proxy: ${plan.proxy.join(", ")}\n`);
        if (plan.proxySkipped.length > 0) {
          io.stdout(`proxy not persisted for ${plan.proxySkipped.join(", ")}: the value carries credentials\n`);
        }
        return 0;
      }
      const result = await install(deps, { agents, fallback });
      io.stdout(`\nConnected: ${result.installed.map((entry) => entry.agentKind).join(", ")}\n`);
      const skipped = result.skipped.filter((kind) => kind !== "other");
      if (skipped.length > 0) {
        io.stdout(
          `Detected but not capturable yet: ${skipped.join(", ")} — nothing was written for these. ` +
            "Your Soul still works in them through the remote MCP endpoint (\`37soul login\`).\n",
        );
      }
      const doctor = await runDoctor({ ...deps, runtimeWaitMs: 2000 });
      for (const check of doctor.checks) io.stdout(`${formatCheck(check)}\n`);
      io.stdout(`\n${doctor.ok ? messages(detectLang()).localReady : messages(detectLang()).localNeedsAttention}\n`);
      const summary = doctorSummary(doctor.checks);
      if (summary) io.stdout(summary);
      return doctor.ok ? 0 : 1;
    }
    case "doctor": {
      const doctor = await runDoctor(deps);
      for (const check of doctor.checks) io.stdout(`${formatCheck(check)}\n`);
      const summary = doctorSummary(doctor.checks);
      if (summary) io.stdout(summary);
      for (const note of doctor.notes) io.stdout(`\n${note}\n`);
      return doctor.ok ? 0 : 1;
    }
    case "status": {
      for (const line of await statusReport(deps)) io.stdout(`${line}\n`);
      return 0;
    }
    case "uninstall": {
      const removed = await uninstall(deps);
      io.stdout(`Removed: ${removed.join(", ") || "nothing owned by 37Soul"}\n`);
      return 0;
    }
    case "pause":
    case "resume": {
      const root = path.join(home, ".37soul");
      const state = (await loadState(root)) ?? emptyState();
      if (command === "resume") {
        state.paused = false;
        state.paused_repos = [];
      } else {
        const repoArg = flagValue(rest, "--repo");
        if (repoArg) {
          const key = await normalizeRepoArg(repoArg);
          if (!key) {
            io.stderr(`could not normalize --repo ${repoArg}\n`);
            return 2;
          }
          state.paused_repos = [...new Set([...(state.paused_repos ?? []), key])];
        } else {
          state.paused = true;
        }
      }
      await saveState(root, state);
      io.stdout(command === "pause" ? "capture paused\n" : "capture resumed\n");
      return 0;
    }
    case "hook": {
      const agentKind = flagValue(rest, "--agent") ?? "claude-code";
      const event = flagValue(rest, "--event") ?? "SessionStart";
      const stdin = await io.stdin();
      return runHookCommand({
        home,
        agentKind,
        event,
        fetch: globalThis.fetch,
        stdin,
        stdout: (text) => io.stdout(text),
        stderr: (text) => io.stderr(text),
      });
    }
    case "agentd":
      return startAgentd(io, home);
    case "soul":
      return soulCommand(root, rest, io, deps);
    case "context":
      return currentContextCommand(root, rest, io);
    case "recall":
      return recallCommand(root, rest, io);
    case "bind":
      return bindCommand(root, rest, io, false);
    case "detach":
      return bindCommand(root, rest, io, true);
    case "hosts":
      return hostsCommand(root, rest, io, deps);
    case "whoami":
    case "connect":
      return localIdentityCommand(root, rest, io, deps, command === "connect");
    case "login":
      return loginCommand(root, rest, io, deps);
    case "sync": {
      const allProfiles = rest.includes("--all-profiles");
      if (allProfiles && rest.includes("--profile")) {
        io.stderr("--all-profiles and --profile are mutually exclusive\n");
        return 2;
      }
      let reports;
      if (allProfiles) {
        reports = await runSyncProfiles(root);
      } else {
        const profileId = await profileIdFromArgs(root, rest, io);
        if (profileId === null) return 1;
        reports = [{ profile_id: profileId, report: await runSync(root, profileId) }];
      }
      if (reports.length === 0) {
        io.stderr("No usable assets profile found. Run `37soul install` to initialize local use, or `37soul login` to connect this server. Existing local data was not changed.\n");
        return 1;
      }
      let failed = false;
      for (const { profile_id, report } of reports) {
        io.stdout(
          `profile ${profile_id}: pushed ${report.accepted}, conflicts ${report.conflicts}, pending ${report.pending}` +
            `${report.error ? ` — ${report.error}` : ""}\n`,
        );
        if (report.error) failed = true;
        try {
          const store = await openStore(root, profile_id);
          try {
            const snap = await store.read();
            for (const soul of Object.values(snap.souls)) {
              const label = soulVisibilityLabel(soul, deps.apiBase);
              const avatar = soul.local_avatar_path && !soul.avatar_uploaded ? " — chosen avatar pending upload (retry: 37soul soul avatar)" : "";
              io.stdout(`  ${soul.soul_uid} ${soul.identity.name}: ${label}${avatar}\n`);
            }
          } finally { await store.close(); }
        } catch { /* status output must not turn a completed sync into a failure */ }
      }
      return failed ? 1 : 0;
    }
    case undefined:
    case "-h":
    case "--help":
      io.stdout(USAGE);
      return 0;
    default:
      io.stderr(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

export async function startAgentd(io: CliIO, home: string): Promise<number> {
  const root = path.join(home, ".37soul");
  const config = await loadConfig(root);
  // New asset mode: the daemon must start even when not logged in (no config.json).
  // With no login there are no tokens and nothing uploads, but the single-writer
  // IPC still serves local soul/asset commands. Legacy spool/credentials/queue are
  // untouched and stay outside the transactional asset snapshot.
  const legacyState = await loadState(root);
  const apiBaseUrl =
    (process.env.SOUL37_BASE_URL || config?.api_base_url || "https://37soul.com").replace(/\/+$/, "");
  const machineId = config?.machine_id ?? legacyState.machine_id;
  // Legacy transcript credentials and fallback are retired in every account state.
  // Account metadata can gate asset extraction, never raw upload permission.
  const assetsMode = isAssetsModeSync(root);

  const logger = createRotatingLogger({ file: path.join(root, "agentd.log") });
  const daemon = createDaemon(
    {
      root,
      apiBaseUrl,
      machineId,
      tokens: {},
      home,
      transcriptFallback: [],
    },
    {
      log: logger,
      fetch: globalThis.fetch,
      getGitState,
      // Task 10: wire the runtime adapters + spawn NativeInvoker into agentd's
      // assets-mode drain (only assets mode has extraction watermarks). The data
      // root is passed so readSource can resolve event refs through the local
      // path-pointer index (Task 10c).
      extractAdapters: agentdExtractAdapters(home, assetsMode, logger, root),
    },
  );

  // Single-writer IPC for local soul assets. Best-effort: IPC unavailability must
  // never fail the user's working session. The writer's sync transport is injected
  // here (the agentd process hosts the writer), never read from `globalThis.fetch`.
  configureSyncHttp(globalThis.fetch as HttpFetch);
  configureCloudSelectionHttp(globalThis.fetch);
  const writer = await startWriter(root).catch((error) => {
    logger.error(`writer failed to start: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  await daemon.tick();
  logger.info("agentd started");

  const interval = setInterval(() => {
    daemon.tick().catch((error: Error) => logger.error(`tick failed: ${error.message}`));
  }, 30_000);

  const { watch } = await import("node:fs");
  let scheduled: NodeJS.Timeout | null = null;
  const schedule = () => {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      daemon.tick().catch((error: Error) => logger.error(`watch tick failed: ${error.message}`));
    }, 500);
  };
  for (const dir of [path.join(home, ".claude", "projects"), path.join(home, ".codex", "sessions")]) {
    try {
      watch(dir, { recursive: true }, schedule);
    } catch {
      // 目录不存在（那个 Agent 没装）——轮询兜底
    }
  }

  const shutdown = async () => {
    clearInterval(interval);
    if (scheduled) clearTimeout(scheduled);
    if (writer) await writer.close().catch(() => {});
    await daemon.stop().catch(() => {});
    logger.info("agentd stopped");
    await logger.flush().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // 常驻：SetInterval 让事件循环活着；进程在收到信号时退出。
  await new Promise<void>(() => {});
  return 0;
}

// --- Task 3 local soul / binding / login commands ----------------------------------

function soulVisibilityLabel(
  soul: { legacy_host_id: number | null; public?: boolean },
  apiBase: string,
): string {
  if (soul.legacy_host_id === null) {
    return "local only (not public until login + explicit authorization + sync)";
  }
  const link = `${apiBase}/hosts/${soul.legacy_host_id}`;
  if (soul.public === true) return `public: ${link}`;
  if (soul.public === false) return `registered private: ${link}`;
  return `registered; public state unknown: ${link}`;
}

function avatarPathFromArgs(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : path.resolve(value);
}

async function profileIdFromArgs(root: string, rest: string[], io: CliIO): Promise<string | null> {
  const explicit = flagValue(rest, "--profile");
  if (rest.includes("--profile")) {
    if (explicit && !explicit.startsWith("--")) return explicit;
    io.stderr("--profile requires an explicit profile id\n");
    return null;
  }
  const active = resolveLocalAssetsProfileSync(root);
  if (active) return active.profile_id;

  // The only implicit creation fallback is a genuinely uninstalled fresh home.
  // Existing, damaged or ambiguous metadata must never redirect into default.
  const entries = await readdir(profilesDir(root), { withFileTypes: true }).catch(error =>
    error.code === "ENOENT" ? [] : null);
  const exists = async (file: string) => stat(file).then(() => true, error => error.code !== "ENOENT");
  if (entries !== null && !entries.some(entry => entry.isDirectory()) &&
      !(await exists(path.join(root, "config.json"))) && !(await exists(path.join(root, "accounts.json")))) return "default";
  io.stderr("No valid unambiguous active profile. Existing data was not changed. Use --profile <id> to explicitly choose local data, or run 37soul login --profile <new-profile-id> for this server.\n");
  return null;
}

function runtimeFromArgs(rest: string[], defaultValue: RuntimeKind): RuntimeKind {
  const value = flagValue(rest, "--agent") ?? defaultValue;
  return (RUNTIME_KINDS as readonly string[]).includes(value) ? (value as RuntimeKind) : defaultValue;
}

/**
 * Dispatch a writer command: try the running writer (agentd) first; if none is
 * listening, start one in-process for this single request, then close it. This
 * keeps every mutation on the single-writer path (never a private bypass).
 */
async function runWriterCommand(
  root: string,
  profileId: ProfileId,
  command: WriterCommand,
  payload: Record<string, unknown>,
): Promise<WriterResult> {
  const request = { request_uid: randomUUID(), profile_id: profileId, command, payload };
  const direct = await sendWriter(root, request);
  if (direct.ok || direct.error.code !== "writer_unavailable") return direct;
  const writer = await startWriter(root).catch(() => null);
  if (!writer) {
    return { ok: false, error: { code: "writer_unavailable", message: "no writer is running — start agentd first" } };
  }
  try {
    return await sendWriter(root, request);
  } finally {
    await writer.close().catch(() => {});
  }
}

async function readProfileDeviceId(root: string, profileId: ProfileId): Promise<string> {
  const store = await openStore(root, profileId);
  try {
    return (await store.read()).device_id;
  } finally {
    await store.close();
  }
}

/**
 * `37soul recall "<terms>"` — 检索她记得的关于你的事。
 *
 * 纯本地、零模型调用：读本地 snapshot，按关键词/类型/适用条件匹配 active 与
 * candidate 资产（历史墓碑需要显式 --history）。这是 claude-mem 那类工具最常被
 * 用到的动作（"我上次说过什么"），但我们的答案带状态与来源，而不是一堆片段。
 */
async function recallCommand(root: string, rest: string[], io: CliIO): Promise<number> {
  // Consume option values here so only positional/literal query terms are searched.
  const values = new Map<string, string>();
  const seen = new Set<string>();
  const query: string[] = [];
  const valueFlags = ["--profile", "--soul", "--host", "--name", "--kind", "--limit"];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      query.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      query.push(arg);
      continue;
    }
    if (!valueFlags.includes(arg) && arg !== "--history" && arg !== "--all") {
      io.stderr(`unknown recall option: ${arg}; use -- before literal query terms starting with -\n`);
      return 2;
    }
    if (seen.has(arg)) {
      io.stderr(`${arg} may only be specified once\n`);
      return 2;
    }
    seen.add(arg);
    if (valueFlags.includes(arg)) {
      const value = rest[++i];
      if (value === undefined || !value.trim() || value.startsWith("--")) {
        io.stderr(`${arg} requires a non-empty value\n`);
        return 2;
      }
      values.set(arg, value);
    }
  }

  const selectors = ["--soul", "--host", "--name", "--all"].filter(flag => seen.has(flag));
  if (selectors.length > 1) {
    io.stderr("--soul, --host, --name and --all are mutually exclusive; choose one\n");
    return 2;
  }
  const kindFlag = values.get("--kind");
  if (kindFlag !== undefined && kindFlag !== "relationship" && kindFlag !== "experience") {
    io.stderr('--kind must be "relationship" or "experience"\n');
    return 2;
  }
  const limitFlag = values.get("--limit");
  const limit = limitFlag === undefined ? 10 : Number(limitFlag);
  if (limitFlag !== undefined && (!/^\d+$/.test(limitFlag) || limit < 1 || limit > 100)) {
    io.stderr("--limit must be a positive integer from 1 to 100\n");
    return 2;
  }
  const hostFlag = values.get("--host");
  const hostId = hostFlag === undefined ? undefined : Number(hostFlag);
  if (hostFlag !== undefined && (!/^\d+$/.test(hostFlag) || !Number.isSafeInteger(hostId) || hostId! < 1)) {
    io.stderr("--host must be a positive safe integer ID\n");
    return 2;
  }
  const profileFlag = values.get("--profile");
  if (profileFlag !== undefined && (profileFlag === "." || profileFlag === ".." || /[/\\\0]/.test(profileFlag))) {
    io.stderr("--profile contains an invalid profile id\n");
    return 2;
  }
  const profileId = profileFlag ?? resolveLocalAssetsProfileSync(root)?.profile_id;
  if (!profileId) {
    io.stderr("No valid unambiguous active profile. Use --profile <id> to explicitly choose local data.\n");
    return 1;
  }

  // Bypass device bootstrap: read() still validates snapshots and reads backups, but no
  // device metadata is created when recalling from an uninitialized profile.
  const store = await openStore(root, profileId, { deviceId: "recall-read-only" });
  let snap: Awaited<ReturnType<typeof store.read>>;
  try {
    snap = await store.read();
  } catch (error) {
    io.stderr(`Could not read local profile ${profileId}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await store.close();
  }

  const souls = Object.values(snap.souls);
  type LocalSoul = (typeof souls)[number];
  const label = (soul: LocalSoul): string =>
    `${JSON.stringify(soul.identity.name)} (UID: ${soul.soul_uid}${soul.legacy_host_id == null ? "" : `, host: ${soul.legacy_host_id}`})`;
  const listSouls = (choices: LocalSoul[]): void => {
    for (const soul of choices) io.stderr(`  ${label(soul)}\n`);
    io.stderr("Choose 37soul recall --soul <uid>, --host <id> or --name <exact name>; --all explicitly searches all local Souls in this profile.\n");
  };
  if (souls.length === 0) {
    io.stderr(`No local Souls in profile ${profileId}. Use 37soul soul list --profile ${profileId} to check local data.\n`);
    return 1;
  }

  const all = seen.has("--all");
  let selected = souls;
  const selector = selectors[0];
  if (selector === "--soul") selected = souls.filter(soul => soul.soul_uid === values.get("--soul"));
  if (selector === "--host") selected = souls.filter(soul => soul.legacy_host_id === hostId);
  if (selector === "--name") selected = souls.filter(soul => soul.identity.name === values.get("--name"));
  if (!all && selected.length !== 1) {
    if (selected.length === 0) {
      io.stderr(`No local Soul found for ${selector} ${JSON.stringify(values.get(selector))} in profile ${profileId}.\n`);
      listSouls(souls);
    } else {
      io.stderr(selector === "--name"
        ? "Multiple local Souls have that exact name. Use --soul <uid> or --host <id> to disambiguate.\n"
        : "Multiple local Souls found. Select one before recalling memories.\n");
      listSouls(selected);
    }
    return 1;
  }

  const selectedByUid = new Map(selected.map(soul => [soul.soul_uid, soul]));
  // Scope before matching/ranking/limiting; orphan assets are never eligible.
  const assets = Object.values(snap.assets).filter(asset => selectedByUid.has(asset.soul_uid));
  const terms = parseTerms(query.join(" "));
  const includeHistory = seen.has("--history");
  const hits = recallAssets(assets, { terms, kind: kindFlag, includeHistory, limit });

  if (!all) io.stdout(`Soul: ${label(selected[0])}\n`);
  if (hits.length === 0) {
    io.stdout(terms.length > 0
      ? `nothing matches ${terms.join(" ").replace(/\n/g, " ")}\n`
      : all ? "no memories recorded for local Souls yet\n" : "she has not recorded anything yet\n");
    return 0;
  }
  for (const hit of hits) {
    const prefix = all ? `Soul: ${label(selectedByUid.get(hit.asset.soul_uid)!)} · ` : "";
    io.stdout(`${prefix}${formatRecallHit(hit)}\n`);
  }
  if (!includeHistory) io.stdout(`(${hits.length} hit(s); add --history to include replaced/deleted versions)\n`);
  return 0;
}

async function soulCommand(root: string, rest: string[], io: CliIO, deps: InstallDeps): Promise<number> {
  const [sub, ...args] = rest;
  const profileId = await profileIdFromArgs(root, args, io);
  if (profileId === null) return 1;

  if (sub === "create") {
    const ageValue = flagValue(args, "--age");
    const identity = {
      name: flagValue(args, "--name") ?? "",
      description: flagValue(args, "--description") ?? "",
      character: flagValue(args, "--character") ?? "",
      greeting: flagValue(args, "--greeting") ?? "",
      sex: flagValue(args, "--sex") as "male" | "female" | "other" | undefined,
      age: ageValue !== undefined ? Number(ageValue) : undefined,
    };
    const missing = validatePublicProfile(identity);
    if (missing.length > 0) {
      io.stderr(`missing or invalid Soul profile fields: ${missing.join(", ")}
`);
      io.stderr('usage: 37soul soul create --name <n> --sex <male|female|other> --age <16-65> --character <at least 50 chars> --avatar <path>\n');
      return 2;
    }
    const avatarPath = avatarPathFromArgs(flagValue(args, "--avatar"));
    try { await readAvatarFile(avatarPath); }
    catch (error) { io.stderr(`${error instanceof Error ? error.message : 'a valid photo is required'}\n`); return 2; }
    const res = await runWriterCommand(root, profileId, "create_soul", { identity, avatar_path: avatarPath });
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    const soul = res.result as { soul_uid: string };
    io.stdout(`created soul ${soul.soul_uid} (local only; public after login, explicit authorization and sync)\n`);
    return 0;
  }

  if (sub === "list") {
    const store = await openStore(root, profileId);
    let souls: Array<{ soul_uid: string; legacy_host_id: number | null; public?: boolean; identity: { name: string }; local_avatar_path?: string; avatar_uploaded?: boolean }> = [];
    try {
      souls = Object.values((await store.read()).souls);
    } finally {
      await store.close();
    }
    if (souls.length === 0) io.stdout("no local souls\n");
    for (const soul of souls) {
      const state = soulVisibilityLabel(soul, deps.apiBase);
      const avatar = soul.local_avatar_path && !soul.avatar_uploaded ? "  [chosen avatar pending upload]" : "";
      io.stdout(`- ${soul.soul_uid}  ${soul.identity.name}  (${state})${avatar}\n`);
    }
    return 0;
  }

  if (sub === "select") {
    const soulUid = args[0];
    if (!soulUid) {
      io.stderr("usage: 37soul soul select <soul_uid> [--agent <kind>]\n");
      return 2;
    }
    const agent = flagValue(args, "--agent");
    if (agent) {
      await setToolDefault({ profile_id: profileId, runtime_kind: runtimeFromArgs(args, "claude-code") }, soulUid, { root });
      io.stdout(`default soul for ${runtimeFromArgs(args, "claude-code")}: ${soulUid}\n`);
    } else {
      await setAccountDefaultSoul(profileId, soulUid, { root });
      io.stdout(`account default soul: ${soulUid}\n`);
    }
    return 0;
  }

  if (sub === "edit") {
    const soulUid = args[0];
    if (!soulUid) {
      io.stderr("usage: 37soul soul edit <soul_uid> [--name <n>] [--description <d>] [--character <c>] [--greeting <g>]\n");
      return 2;
    }
    const store = await openStore(root, profileId);
    let current: { legacy_host_id: number | null; identity: { name: string; description: string; character: string; greeting: string; sex?: "male" | "female" | "other"; age?: number } } | undefined;
    try {
      current = (await store.read()).souls[soulUid];
    } finally {
      await store.close();
    }
    if (!current) {
      io.stderr(`no local soul ${soulUid}\n`);
      return 1;
    }
    const pick = (flag: string, key: "name" | "description" | "character" | "greeting"): string =>
      flagValue(args, flag) ?? current!.identity[key] ?? "";
    if (current.legacy_host_id !== null) {
      io.stderr("edit_on_website: this Soul is registered — edit its identity on 37soul.com\n");
      return 1;
    }
    const currentIdentity = current.identity;
    const ageValue = flagValue(args, "--age");
    const identity = {
      name: pick("--name", "name"),
      description: pick("--description", "description"),
      character: pick("--character", "character"),
      greeting: pick("--greeting", "greeting"),
      sex: (flagValue(args, "--sex") ?? currentIdentity.sex) as "male" | "female" | "other" | undefined,
      age: ageValue !== undefined ? Number(ageValue) : currentIdentity.age,
    };
    const missing = validatePublicProfile(identity);
    if (missing.length > 0) {
      io.stderr(`missing or invalid Soul profile fields: ${missing.join(", ")}; complete name, sex, age and at least 50-character character\n`);
      return 2;
    }
    const avatarPath = avatarPathFromArgs(flagValue(args, "--avatar"));
    if (avatarPath) {
      try { await readAvatarFile(avatarPath); }
      catch (error) { io.stderr(`${error instanceof Error ? error.message : 'a valid photo is required'}\n`); return 2; }
    }
    const res = await runWriterCommand(root, profileId, "edit_local_identity", { soul_uid: soulUid, identity, validate_public_profile: true, ...(avatarPath ? { avatar_path: avatarPath } : {}) });
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    io.stdout(`updated soul ${soulUid}\n`);
    return 0;
  }

  if (sub === "avatar") {
    const soulUid = args[0];
    const file = avatarPathFromArgs(flagValue(args, "--file") ?? flagValue(args, "--avatar"));
    if (!soulUid || !file) {
      io.stderr("usage: 37soul soul avatar <soul_uid> --file <image> [--profile <id>]\n");
      return 2;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
    } catch {
      io.stderr(`avatar file not found: ${file}\n`);
      return 2;
    }
    // One writer request performs both the local selection write and the upload.
    // The writer's injected transport and its serialization protect concurrent
    // create/sync commands from an old avatar ACK overwriting a newer snapshot.
    const res = await runWriterCommand(root, profileId, "upload_avatar", {
      soul_uid: soulUid,
      local_avatar_path: file,
    });
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    const result = res.result as { status: string; soul_uid?: string; avatar_url?: string; error?: string } | null;
    if (result?.status === "uploaded") {
      io.stdout(`avatar uploaded for ${soulUid}${result.avatar_url ? `: ${result.avatar_url}` : ""}\n`);
      return 0;
    }
    if (result?.status === "not_logged_in") {
      io.stderr("avatar saved locally; run 37soul login before uploading\n");
      return 0;
    }
    if (result?.status === "not_registered") {
      io.stderr("avatar saved locally; authorize and sync this Soul before uploading\n");
      return 0;
    }
    if (result?.status === "not_authorized") {
      io.stderr("avatar saved locally; identity sync is not authorized for this Soul\n");
      return 0;
    }
    io.stderr(`avatar upload failed${result?.error ? ` (${result.error})` : ""}; image kept locally for retry\n`);
    return 1;
  }

  if (sub === "authorize") {
    const soulUid = args[0];
    if (!soulUid) {
      io.stderr("usage: 37soul soul authorize <soul_uid> [--categories identity,relationship,experience]\n");
      return 2;
    }
    const categories = flagValue(args, "--categories") ?? flagValue(args, "--consent") ?? "identity";
    const store = await openStore(root, profileId);
    let before: { legacy_host_id: number | null; public?: boolean } | undefined;
    try { before = (await store.read()).souls[soulUid]; } finally { await store.close(); }
    if (!before) {
      io.stderr(`unknown_soul: no local soul ${soulUid} in this profile\n`);
      return 1;
    }
    if (before.legacy_host_id === null) {
      io.stdout("This will queue public registration: the profile you entered will be public; private chats and personal memories will not be public.\n");
    } else if (before.public === true) {
      io.stdout("This Soul is already public; this command only updates sync consent. Private chats and personal memories are not public.\n");
    } else if (before.public === false) {
      io.stdout("This Soul is registered as private; this command only updates sync consent and does not publish it.\n");
    } else {
      io.stdout("This Soul is registered but its public state is unknown; this command only updates sync consent and does not change visibility.\n");
    }
    const res = await runWriterCommand(root, profileId, "authorize_soul", { soul_uid: soulUid, categories, publish_profile: true });
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    const result = res.result as { operation?: string; categories?: string[] } | null;
    io.stdout(
      `authorized soul ${soulUid}: ${result?.operation ?? "sync"} (${(result?.categories ?? []).join(",") || "none"})\n`,
    );
    return 0;
  }

  if (sub === "export") {
    const res = await runWriterCommand(root, profileId, "export", {});
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    io.stdout(`${JSON.stringify(res.result, null, 2)}\n`);
    return 0;
  }

  if (sub === "review" || sub === "delete") {
    // Owner write commands are interactive-CLI-only: they mutate the Soul and must
    // never run from a piped/scripted context (and never appear as MCP tools).
    if (!process.stdin.isTTY) {
      io.stderr(`refusing soul ${sub}: it changes the Soul and needs an interactive terminal (stdin is not a TTY)\n`);
      return 2;
    }
    const assetUid = args[0];
    if (!assetUid) {
      io.stderr(`usage: 37soul soul ${sub} <asset_uid> [--profile <id>]\n`);
      return 2;
    }
    if (sub === "review") {
      const approve = args.includes("--approve");
      const reject = args.includes("--reject");
      if (approve === reject) {
        io.stderr("usage: 37soul soul review <asset_uid> --approve|--reject [--profile <id>]\n");
        return 2;
      }
      const res = await runWriterCommand(root, profileId, "review_asset", {
        asset_uid: assetUid,
        action: approve ? "approve" : "reject",
      });
      if (!res.ok) {
        io.stderr(`${res.error.code}: ${res.error.message}\n`);
        return 1;
      }
      io.stdout(`reviewed ${assetUid}: ${approve ? "approved" : "rejected"}\n`);
      return 0;
    }
    const res = await runWriterCommand(root, profileId, "delete_asset", { asset_uid: assetUid });
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    io.stdout(`deleted ${assetUid}\n`);
    return 0;
  }

  io.stderr(`unknown soul command: ${sub ?? ""}\n\n${USAGE}`);
  return 2;
}

/** Local context restoration for the exact executing Codex session; never creates a binding. */
async function currentContextCommand(root: string, rest: string[], io: CliIO): Promise<number> {
  const session = codexEnvironmentSession();
  if (!session) {io.stderr("Current Codex native session ID is unavailable. No context was read.\n"); return 2;}
  const profile = await profileIdFromArgs(root, rest, io); if (profile === null) return 1;
  const store = await openStore(root, profile);
  try {
    const snap = await store.read();
    const key = {profile_id: profile, device_id: snap.device_id, runtime_kind: "codex" as const, native_session_id: session};
    const binding = snap.bindings[bindingKey(key)];
    if (!binding || binding.state !== "bound" || binding.retired) {io.stderr("This Codex session has no selected Soul. Use 37soul connect with the chosen name or Host ID.\n"); return 1;}
    const input=ownerContextInput(snap,binding.soul_uid,binding,"session");
    const reads=localReadCapabilities(snap.souls[binding.soul_uid]?.legacy_host_id,binding.runtime_kind);
    const readHint=reads?"\n[Local reads for this Soul]\n"+JSON.stringify(reads):"";
    const bundle = selectContext({...input, budgetBytes: 4096-Buffer.byteLength(readHint,"utf8")}, {identityBudgetBytes: 2048});
    io.stdout(bundle.rendered_text + readHint + "\n"); return 0;
  } catch (error) {io.stderr(error instanceof StoreError ? error.message + "\n" : "Could not read this session's local Soul context.\n"); return 1;}
  finally {await store.close();}
}

async function hostsCommand(root: string, rest: string[], io: CliIO, deps: {apiBase: string; fetch: typeof fetch}): Promise<number> {
  const runtime = flagValue(rest, "--agent");
  const limitArg = flagValue(rest, "--limit") ?? "50";
  const offsetArg = flagValue(rest, "--offset") ?? "0";
  if ((rest.includes("--agent") && !(RUNTIME_KINDS as readonly string[]).includes(runtime ?? "")) || !/^\d+$/.test(limitArg) || !/^\d+$/.test(offsetArg) || Number(limitArg) < 1 || Number(limitArg) > 50 || !Number.isSafeInteger(Number(offsetArg)) || (rest.includes("--name") && !flagValue(rest, "--name")?.trim())) {
    io.stderr("Use a supported --agent, --limit 1..50, --offset >=0, and a nonempty --name.\n"); return 2;
  }
  const profile = await profileIdFromArgs(root, rest, io); if (profile === null) return 1;
  try { io.stdout(`${JSON.stringify(await ownedHosts(root, profile, runtime as RuntimeKind | undefined, {name: flagValue(rest, "--name"), limit: Number(limitArg), offset: Number(offsetArg)}, deps), null, 2)}\n`); return 0; }
  catch (error) { io.stderr(`${error instanceof StoreError ? error.message : "Could not list owned Souls: network or timeout error."}\n`); return 1; }
}

function nativeContextRecoveryMessage(reason: string, hostId: number, name?: string): string {
  const target = name ? `name ${JSON.stringify(name)}` : `host ${hostId}`;
  return `${reason} Requested Soul: ${target}. Run 37soul doctor to check runtime and hook approval/loading; in Codex, review the current hook in /hooks. Keep this choice and resume the same request once managed context is available, without asking the user to repeat their selection. Never guess another session or repeat login/OAuth.`;
}

async function localIdentityCommand(root: string, rest: string[], io: CliIO, deps: {apiBase: string; fetch: typeof fetch}, attach: boolean): Promise<number> {
  const hostArg = flagValue(rest, "--host");
  let hostId = hostArg && /^[1-9]\d*$/.test(hostArg) ? Number(hostArg) : NaN;
  const name = flagValue(rest, "--name")?.trim();
  let runtime = flagValue(rest, "--agent");
  let session = flagValue(rest, "--session");
  const nativeSession = attach ? codexEnvironmentSession() : null;
  if (nativeSession) {
    if ((runtime !== undefined && runtime !== "codex") || (session && session !== nativeSession)) {io.stderr("The requested session conflicts with the current Codex native session.\n"); return 2;}
    runtime = "codex"; session = nativeSession;
  }
  if ((rest.includes("--agent") && !(RUNTIME_KINDS as readonly string[]).includes(runtime ?? "")) || (attach && name && rest.includes("--host")) || (!Number.isSafeInteger(hostId) && !(attach && name && !rest.includes("--host")))) {
    io.stderr("Choose a positive --host, or connect --name with an exact displayed name; --agent must be a supported runtime.\n"); return 2;
  }
  if (attach && (!runtime || !session || session.startsWith("--"))) {
    io.stderr(`${nativeContextRecoveryMessage("connect requires --agent and --session from the current native hook context.", hostId, name)}\n`); return 2;
  }
  const profile = await profileIdFromArgs(root, rest, io); if (profile === null) return 1;
  const requireActive = async () => {
    const latest = await loadConfig(root);
    if ((latest?.active_profile_id !== undefined && latest.active_profile_id !== profile) || resolveLocalAssetsProfileSync(root)?.profile_id !== profile) throw new StoreError("active_profile_changed", "The active account/profile changed. Retry the connection using the current native hook context.");
  };
  let prefetch: {hostId:number;controller:AbortController;read:Promise<{recheck?:()=>Promise<Record<string,unknown>>;error?:unknown}>} | undefined;
  let upstreamSignal:AbortSignal|undefined;
  let abortUpstream:(()=>void)|undefined;
  try {
    let directoryTarget: {id:number;soul_uid:string} | undefined;
    if (attach) {
      await requireActive();
      const deviceId = await readProfileDeviceId(root, profile);
      if (runtime === "codex" && nativeSession === session) {
        const file = await findCodexRollout(path.dirname(root), session!, process.env.CODEX_HOME);
        if (!file) throw new StoreError("session_context_unavailable", "The current Codex native rollout is missing or ambiguous. Keep the chosen Soul and retry when its local session record is available; no hook approval or new login is required.");
        await captureSourcePointer(root, profile, randomUUID(), {runtime_kind: "codex", native_session_id: session!, path: file, captured_at: new Date().toISOString()});
      }
      const source = await sessionSourceBoundary(root, {profile_id: profile,device_id: deviceId,runtime_kind: runtime as RuntimeKind,native_session_id: session!});
      if (!source) throw new StoreError("session_context_unavailable", nativeContextRecoveryMessage("The current session has no valid hook source context yet.", hostId, name));
      if (name) {
        const localStore=await openStore(root,profile);let candidate:number|undefined;
        try{const local=await localStore.read();const matches=Object.values(local.souls).filter(s=>s.identity.name.trim().toLowerCase()===name.toLowerCase());
          if(matches.length===1){const soul=matches[0],consent=local.consents[`${local.cloud_device_uid}:${soul.soul_uid}`];if(soul.legacy_host_id&&consent?.enabled&&consent.categories.includes("identity"))candidate=soul.legacy_host_id;}}
        finally{await localStore.close();}
        if(candidate){
          const controller=new AbortController();
          const fetcher:typeof fetch=(input,init)=>{upstreamSignal=init?.signal??undefined;abortUpstream=()=>controller.abort();if(upstreamSignal?.aborted)controller.abort();else upstreamSignal?.addEventListener("abort",abortUpstream,{once:true});return deps.fetch(input,{...init,signal:controller.signal});};
          prefetch={hostId:candidate,controller,read:prepareLocalIdentity(root,profile,candidate,runtime as RuntimeKind,{...deps,fetch:fetcher}).then(recheck=>({recheck}),error=>({error}))};
        }
        const directory = await ownedHosts(root, profile, runtime as RuntimeKind, {name,limit:2}, deps);
        const matches = directory.hosts.filter(host => host.nickname.trim().toLowerCase() === name.toLowerCase());
        if (matches.length === 0) throw new StoreError("unknown_soul", "No owned Soul with that name was found. List 37soul hosts; do not create a replacement.");
        if (matches.length !== 1 || directory.pagination.total !== 1 || directory.pagination.has_more) throw new StoreError("ambiguous_soul", `Multiple Souls share that name. Ask which Host ID: ${matches.map(host=>host.id).join(", ")}.`);
        hostId = matches[0].id; directoryTarget = matches[0];
        if(prefetch&&prefetch.hostId!==hostId)prefetch.controller.abort();
      }
      const store = await openStore(root, profile); let ready: boolean;
      try {
        const snap = await store.read();const soul = Object.values(snap.souls).find(s=>s.legacy_host_id===hostId);const consent = soul ? snap.consents[`${snap.cloud_device_uid}:${soul.soul_uid}`] : undefined;
        if (consent && (!consent.enabled || !consent.categories.includes("identity"))) throw new StoreError("soul_consent_revoked", "This Soul has disabled consent; re-enable it explicitly before reconnecting.");
        ready = Boolean(soul && consent?.enabled && consent.categories.includes("identity"));
      } finally { await store.close(); }
      if (!ready) {
        let target = directoryTarget;
        if (!target) {
          const directory = await ownedHosts(root, profile, runtime as RuntimeKind, {hostId,limit:2}, deps);
          target = directory.hosts.find(host=>host.id===hostId);
          if (directory.pagination.total !== 1) target = undefined;
        }
        if (!target) throw new StoreError("unknown_soul", "No owned Soul with this Host ID was found. Do not create a replacement.");
        const selected = await runWriterCommand(root, profile, "select_cloud_soul", {host_id:hostId,soul_uid:target.soul_uid,runtime_kind:runtime});
        if (!selected.ok) throw new StoreError(selected.error.code, selected.error.message);
        const synced = await runSync(root, profile);
        if (synced.error) throw new StoreError("restore_pending", "This Soul was selected but its download is pending. Retry 37soul connect; account login is already complete.");
      }
    }
    let recheck: (()=>Promise<Record<string,unknown>>)|undefined;
    if(prefetch?.hostId===hostId){const prepared=await prefetch.read;if(prepared.error)throw prepared.error;recheck=prepared.recheck;}
    const identity = recheck ? await recheck() : await readLocalIdentity(root, profile, hostId, runtime as RuntimeKind | undefined, deps);
    if (attach || !rest.includes("--profile")) await requireActive();
    if (attach) {
      const store = await openStore(root, profile);let snap;
      try {snap=await store.read();} finally {await store.close();}
      const soul = Object.values(snap.souls).find(s=>s.legacy_host_id===hostId);
      if (!soul) throw new StoreError("restore_pending", "The selected Soul has not downloaded. Retry 37soul connect; do not log in again.");
      const result = await runWriterCommand(root, profile, "connect_session", {device_id:snap.device_id,runtime_kind:runtime,native_session_id:session,soul_uid:soul.soul_uid,...(runtime === "codex" && nativeSession === session ? {source_mode:"codex-native"} : {})});
      if (!result.ok) throw new StoreError(result.error.code,result.error.message);
      await requireActive();identity.connection={...(result.result as Record<string,unknown>),state:"attached"};
    }
    io.stdout(`${JSON.stringify(attach?compactConnectionIdentity(identity):identity,null,2)}\n`);return 0;
  } catch(error) {io.stderr(`${error instanceof StoreError ? error.message : "Could not connect the selected Soul. Retry locally without remote OAuth."}\n`);return 1;}
  finally{prefetch?.controller.abort();if(upstreamSignal&&abortUpstream)upstreamSignal.removeEventListener("abort",abortUpstream);}
}

export async function bindCommand(root: string, rest: string[], io: CliIO, detach: boolean): Promise<number> {
  const profileId = await profileIdFromArgs(root, rest, io);
  if (profileId === null) return 1;
  const soulUid = flagValue(rest, "--soul") ?? flagValue(rest, "--soul-uid");
  const nativeSessionId = flagValue(rest, "--session") ?? flagValue(rest, "--native-session-id");
  const runtimeKind = runtimeFromArgs(rest, "claude-code");
  if (!detach && !soulUid) {
    io.stderr("usage: 37soul bind --soul <soul_uid> --session <native_id> [--agent <kind>]\n");
    return 2;
  }
  if (!nativeSessionId) {
    io.stderr("usage: 37soul bind/detach --session <native_id> [--agent <kind>]\n");
    return 2;
  }
  const deviceId = await readProfileDeviceId(root, profileId);
  const res = detach
    ? await runWriterCommand(root, profileId, "detach", { device_id: deviceId, runtime_kind: runtimeKind, native_session_id: nativeSessionId })
    : await runWriterCommand(root, profileId, "bind", { device_id: deviceId, runtime_kind: runtimeKind, native_session_id: nativeSessionId, soul_uid: soulUid });
  if (!res.ok) {
    io.stderr(`${res.error.code}: ${res.error.message}\n`);
    return 1;
  }
  // `selectSoul` reports an injected-session switch as a success-shaped writer result
  // whose payload is `{ error: "needs_new_session" }` — surface it, don't print it.
  const result = res.result as { error?: unknown } | null;
  if (result !== null && typeof result === "object" && result.error === "needs_new_session") {
    io.stderr("this session cannot switch Souls in place; start a new session and bind the new Soul there\n");
    return 1;
  }
  // Never print the native session id; report the cloud-facing binding identity only.
  const binding = res.result as { binding_uid: string; revision: number; soul_uid: string };
  io.stdout(
    detach
      ? `detached soul ${binding.soul_uid} (binding ${binding.binding_uid}, revision ${binding.revision})\n`
      : `bound soul ${binding.soul_uid} (binding ${binding.binding_uid}, revision ${binding.revision})\n`,
  );
  return 0;
}

/**
 * 客户端版本号的来源顺序（2026-10-31 走查：设备卡片上显示 0.0.0）。
 *
 * 发布包里的 package.json 只有 `{"type":"module"}`，version 字段在打包时丢了；
 * 只读它会一律退回 0.0.0，运营在网站上看不出用户跑的是哪一版。所以：
 *   1. 同目录上一级的 package.json（源码/开发态）
 *   2. 运行时目录名（`~/.37soul/runtime/0.12.2` —— 安装器按版本建目录）
 *   3. install manifest 里记录的 runtime version
 * 都是本地文件，不发网络请求；全都没有时才承认不知道。
 */
/** 导出以便直接验证「发布包丢 version」时的回落顺序。 */
export async function readClientVersion(cliScriptPath: string): Promise<string> {
  const semver = /^\d+\.\d+\.\d+$/;
  try {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(cliScriptPath), "..", "package.json"), "utf8")) as {
      version?: string;
    };
    if (typeof pkg.version === "string" && semver.test(pkg.version)) return pkg.version;
  } catch {
    // 发布包里可能没有 package.json 或没有 version
  }

  // dist/cli.js → dist → 运行时目录（安装器按版本命名）
  const runtimeDir = path.basename(path.dirname(path.dirname(cliScriptPath)));
  if (semver.test(runtimeDir)) return runtimeDir;

  try {
    const home = process.env.SOUL37_HOME || (await import("node:os")).homedir();
    const manifest = JSON.parse(await readFile(path.join(home, ".37soul", "install-manifest.json"), "utf8")) as {
      entries?: Array<{ kind?: string; version?: string }>;
    };
    const runtime = (manifest.entries ?? []).find((e) => e.kind === "runtime" && typeof e.version === "string");
    if (runtime?.version && semver.test(runtime.version)) return runtime.version;
  } catch {
    // 没有 manifest：当作不知道
  }
  return "0.0.0";
}


/** 一行渲染一个 doctor check：✓ 通过 · ✗ 需要处理 · … 还没发生（等待态）。 */
function formatCheck(check: { ok: boolean; waiting?: boolean; name: string; detail?: string }): string {
  const mark = check.waiting && !check.ok ? "…" : check.ok ? "✓" : "✗";
  return `${mark} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`;
}

/**
 * doctor 末尾的「怎么读这些结果」。
 * 2026-10-31 走查：全新安装会同时出现 7 个 ✗（codex 未信任、opencode 未加载、
 * hermes 无模型授权、4 个 no events），没有人告诉新手哪些是正常的。
 */
function doctorSummary(checks: readonly { ok: boolean; waiting?: boolean; name: string }[]): string {
  const blocked = checks.filter((c) => !c.ok && !c.waiting);
  const waiting = checks.filter((c) => c.waiting && !c.ok).length;
  if (blocked.length === 0) {
    return waiting > 0
      ? `\n${waiting} item(s) marked … are waiting on the host agent itself — they turn into ✓ the first time you use that agent.\n`
      : "";
  }

  // 只提这个安装里真的存在的问题：只装了 Pi 时不该被叫去 Codex 的 /hooks。
  const names = blocked.map((c) => c.name).join(" ");
  const actions: string[] = [];
  if (/sync credential/.test(names)) actions.push("run `37soul login` for sync credentials");
  if (/SessionStart hook|hooks/.test(names)) actions.push("approve the hook inside the host (Codex: /hooks)");
  if (/plugin bridge/.test(names)) actions.push("restart the agents you just connected");
  if (actions.length === 0) actions.push("see the ✗ lines above");
  actions.push("restart the agents you just connected");
  const unique = [...new Set(actions)];

  return (
    `\n${blocked.length} item(s) marked ✗ need an action: ${unique.join("; ")}.\n` +
    (waiting > 0 ? `${waiting} item(s) marked … are waiting on the host agent — they turn into ✓ after first use.\n` : "")
  );
}

export interface ProfileCandidate {
  profile_id: string;
  soul_count: number;
  pending_count: number;
  conflict_count: number;
  modified_at: number | null;
}

/**
 * Existing local profiles already owned by `ownerId`, excluding the current one.
 * Read-only peek for the user-visible login choice: soul count, pending/conflict
 * counts and snapshot mtime — never tokens or native session ids.
 */
async function listSameOwnerProfiles(
  root: string,
  ownerId: string,
  currentProfileId: string,
  issuer: string,
): Promise<ProfileCandidate[]> {
  const entries = await readdir(profilesDir(root), { withFileTypes: true }).catch(() => []);
  const out: ProfileCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (id === currentProfileId) continue;
    let snap;
    try {
      const store = await openStore(root, id);
      try {
        snap = await store.read();
      } finally {
        await store.close();
      }
    } catch {
      continue; // a corrupt/unreadable profile is not offered as a candidate
    }
    if (snap.owner_id !== ownerId || !sameServerIssuer(snap.cloud_issuer, issuer)) continue;
    let modifiedAt: number | null = null;
    try {
      modifiedAt = (await stat(snapshotPath(root, id))).mtimeMs;
    } catch {
      // mtime is cosmetic; a missing stat must not hide the candidate.
    }
    out.push({
      profile_id: id,
      soul_count: Object.keys(snap.souls).length,
      pending_count: Object.keys(snap.outbox).length,
      conflict_count: Object.keys(snap.quarantine).length,
      modified_at: modifiedAt,
    });
  }
  return out;
}

// Readers normalize missing fields. Before login writes shared metadata, reject
// shapes those readers would silently discard; never turn recovery into a reset.
async function invalidLoginMetadata(root: string): Promise<string | null> {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const optionalString = (value: unknown) => value == null || typeof value === "string";
  for (const file of ["config.json", "accounts.json"]) {
    let value: unknown;
    try { value = JSON.parse(await readFile(path.join(root, file), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return file;
    }
    if (!record(value)) return file;
    if (file === "config.json") {
      if (typeof value.api_base_url !== "string" || !value.api_base_url ||
          typeof value.machine_id !== "string" || !value.machine_id ||
          (value.tokens !== undefined && !record(value.tokens)) ||
          (value.credentials !== undefined && !Array.isArray(value.credentials)) ||
          (value.transcript_fallback !== undefined && !Array.isArray(value.transcript_fallback))) return file;
    } else {
      const fields = ["profile_id", "cloud_issuer", "default_soul_uid", "soul_sync_mode"];
      for (const [owner, entry] of Object.entries(value)) {
        if (owner === "__proto__" || !record(entry) || typeof entry.profile_id !== "string" || !entry.profile_id ||
            Object.keys(entry).some(key => !fields.includes(key)) ||
            !optionalString(entry.cloud_issuer) || !optionalString(entry.default_soul_uid) ||
            !optionalString(entry.soul_sync_mode)) return file;
      }
    }
  }
  return null;
}

export async function loginCommand(
  root: string,
  rest: string[],
  io: CliIO,
  deps: InstallDeps,
): Promise<number> {
  const requestedHost = flagValue(rest, "--host");
  const hostId = requestedHost && /^[1-9]\d*$/.test(requestedHost) ? Number(requestedHost) : undefined;
  if (rest.includes("--host") && (!Number.isSafeInteger(hostId) || !hostId)) {
    io.stderr("--host requires a positive integer\n"); return 2;
  }
  const invalidMetadata = await invalidLoginMetadata(root);
  if (invalidMetadata) {
    io.stderr(`Existing ${invalidMetadata} has damaged or unsupported metadata. Existing data was not changed; repair this file before reconnecting.\n`);
    return 1;
  }
  let profileId = await profileIdFromArgs(root, rest, io);
  if (profileId === null && !rest.includes("--profile") &&
      !rest.includes("--merge-profile") && !rest.includes("--use-profile")) {
    let recoveryIssuer: string;
    try { recoveryIssuer = requireCloudIssuer(deps.apiBase); }
    catch { return 1; }
    const recoveryId = `reconnect-${randomUUID()}`;
    io.stderr(`Existing local profiles will be kept unchanged. Reconnecting to ${recoveryIssuer} uses a separate profile; old records will not be copied or merged. After account login, choose your Soul in the local Agent to restore its authorized assets.\n`);
    if (!io.confirm) {
      io.stderr(`To continue explicitly, run: 37soul login${hostId !== undefined ? ` --host ${hostId}` : ""} --profile ${recoveryId}\n`);
      return 1;
    }
    if (await io.confirm(`Keep existing local data unchanged and reconnect to ${recoveryIssuer} in a separate profile (not merged)? [y/N] `)) {
      profileId = recoveryId;
    }
  }
  if (profileId === null) return 1;
  const mergeProfileId = flagValue(rest, "--merge-profile");
  const useProfileId = flagValue(rest, "--use-profile");
  if (mergeProfileId && useProfileId) {
    io.stderr("--merge-profile and --use-profile are mutually exclusive\n");
    return 2;
  }
  let issuer: string;
  try {
    issuer = requireCloudIssuer(deps.apiBase);
    await assertLoginProfileIssuers(root, [profileId, ...(mergeProfileId ? [mergeProfileId] : []), ...(useProfileId ? [useProfileId] : [])], issuer);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const machineId = await readProfileDeviceId(root, profileId);
  const clientVersion = await readClientVersion(fileURLToPath(import.meta.url));

  const login = await deviceLogin(deps, [...RUNTIME_KINDS], { assetsMode: true, machineId, clientVersion, hostId });

  if (!login.owner_id) {
    io.stderr("login returned no owner_id\n");
    return 1;
  }

  // Only same-owner, same-issuer profiles are eligible for explicit adoption.
  const candidates = await listSameOwnerProfiles(root, login.owner_id, profileId, issuer);
  if (candidates.length > 0 && !mergeProfileId && !useProfileId) {
    io.stderr(`you already have ${candidates.length} local profile(s) for owner ${login.owner_id}:\n`);
    for (const candidate of candidates) {
      const modified = candidate.modified_at !== null ? `, modified ${new Date(candidate.modified_at).toISOString()}` : "";
      io.stderr(
        `  ${candidate.profile_id} — ${candidate.soul_count} souls, ${candidate.pending_count} pending, ${candidate.conflict_count} conflicted${modified}\n`,
      );
    }
    io.stderr("rerun with --merge-profile <profile_id> (merge it into this profile) or --use-profile <profile_id> (switch to it)\n");
    return 1;
  }
  const chosen = mergeProfileId ?? useProfileId;
  if (chosen && !candidates.some((candidate) => candidate.profile_id === chosen)) {
    io.stderr(`no same-owner local profile named ${chosen}\n`);
    return 1;
  }

  // §2.5: only the writer process commits. The whole association runs inside one
  // `login_associate` writer dispatch (owner + cloud_device_uid + merge/defaults +
  // soul_sync_mode, or the account-index switch for --use-profile); the CLI process
  // itself never calls store.transact.
  const res = await runWriterCommand(root, profileId, "login_associate", {
    owner_id: login.owner_id,
    cloud_issuer: issuer,
    cloud_device_uid: login.cloud_device_uid ?? null,
    default_soul_uid: login.default_soul_uid ?? null,
    mode: login.mode ?? "assets_only",
    ...(mergeProfileId ? { merge_profile_id: mergeProfileId } : {}),
    ...(useProfileId ? { use_profile_id: useProfileId } : {}),
  });
  if (!res.ok) {
    io.stderr(`${res.error.code}: ${res.error.message}\n`);
    return 1;
  }
  // Persist the device tokens the login just granted with their owner/cloud-device/
  // profile/runtime scope. Tokens are written to config.json only — never the
  // snapshot, outbox, receipt, error, log or CLI output.
  const adoptedResult = res.result as { profile_id?: unknown; owner_id?: unknown } | null;
  const adoptedProfileForCredentials =
    adoptedResult && typeof adoptedResult.profile_id === "string" ? adoptedResult.profile_id : profileId;
  if (login.owner_id && login.cloud_device_uid && Object.keys(login.tokens).length > 0) {
    await saveLoginCredentials(root, {
      apiBaseUrl: deps.apiBase,
      machineId,
      profileId: adoptedProfileForCredentials,
      ownerId: login.owner_id,
      cloudDeviceUid: login.cloud_device_uid,
      tokens: login.tokens,
    });
  }

  // "login then first sync": best-effort push/pull of every assets-mode profile.
  // A sync failure must never fail the login — surface it on stderr and keep going.
  try {
    const synced = await runSyncProfiles(root);
    for (const { report } of synced) {
      if (report.error) io.stderr(`sync deferred: ${report.error}\n`);
    }
  } catch (error) {
    io.stderr(`sync deferred: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Path B: the selected website Soul arrives via the first Pull, not in the
  // pre-login snapshot. Set it as the account default only after it actually exists
  // locally; never fabricate a same-name replacement.
  let targetReady = false;
  if (login.default_soul_uid) {
    try {
      const store = await openStore(root, adoptedProfileForCredentials);
      try {
        const snap = await store.read();
        const restored = snap.souls[login.default_soul_uid];
        if (restored && (hostId === undefined || restored.legacy_host_id === hostId)) {
          targetReady = true;
          await setAccountDefaultSoul(adoptedProfileForCredentials, login.default_soul_uid, { root });
          const assets = Object.values(snap.assets).filter(
            (asset) => asset.soul_uid === login.default_soul_uid && asset.state !== "deleted",
          );
          io.stdout(`Soul restored: ${restored.identity.name || restored.soul_uid} (${restored.soul_uid}), ${assets.length} asset(s)\n`);
        } else {
          io.stderr(`the selected Soul ${login.default_soul_uid} has not downloaded yet; run 37soul sync\n`);
        }
      } finally {
        await store.close();
      }
    } catch {
      // A failed default write must not turn a successful login into an error.
    }
  }

  // Print the profile actually adopted (the writer result), never the current/anonymous
  // id — so the success line can never disagree with accounts.json.
  const adopted = res.result as { profile_id?: unknown; owner_id?: unknown } | null;
  const adoptedProfile = adopted && typeof adopted.profile_id === "string" ? adopted.profile_id : profileId;
  const adoptedOwner = adopted && typeof adopted.owner_id === "string" ? adopted.owner_id : login.owner_id;
  io.stdout(`logged in as owner ${adoptedOwner} (profile ${adoptedProfile})\n`);
  if (hostId !== undefined && !targetReady) {
    io.stderr(`Account authorized, but the requested Soul ${hostId} is not ready. Run 37soul login --host ${hostId}, approve that Soul and verify Soul restored before connecting the Agent.\n`);
    return 1;
  }
  if (!login.default_soul_uid) io.stdout("Account ready. Choose any of your Souls in your Agent; 37soul hosts lists the available roles. No Soul was selected during login.\n");
  return 0;
}

async function normalizeRepoArg(value: string): Promise<string | null> {
  if (value.startsWith("path:") || /^[A-Za-z0-9.-]+\//.test(value)) return value;
  try {
    const git = await getGitState(value);
    return repoKey({ remote: git.repo.remote, machineId: "cli", cwd: value });
  } catch {
    return null;
  }
}
function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function runCommandReal(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

export function processIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    confirm: process.stdin.isTTY && process.stderr.isTTY ? async (message) => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      const controller = new AbortController();
      terminal.once("close", () => controller.abort());
      terminal.once("SIGINT", () => controller.abort());
      try {
        const answer = await terminal.question(message, { signal: controller.signal });
        return /^(y|yes)$/i.test(answer.trim());
      } catch { return false; }
      finally { terminal.close(); }
    } : undefined,
    stdin: () =>
      new Promise((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", () => resolve(data));
        if (process.stdin.isTTY) resolve("");
      }),
  };
}

// 仅在作为可执行入口运行时自动执行（被测试 import 时不动）。
// ⚠️ 用 realpath 比较：macOS 的 /tmp 是 /private/tmp 的符号链接，直接比较会让
// 经启动器/临时目录调用时「静默什么都不做」。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2), processIO()).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`37soul: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

/** 导出给测试：渲染与总结是纯函数。 */
export const formatCheckForTest = formatCheck;
export const doctorSummaryForTest = doctorSummary;
