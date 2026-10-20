#!/usr/bin/env node
/**
 * `37soul` CLI（设计 §6.1）：install / doctor / status / uninstall / pause / resume，
 * 以及两个内部命令 `agentd`（后台采集进程）和 `hook --agent <kind>`（SessionStart）。
 *
 * npm 发布是独立的一步：在包名发布完成之前，本地用 `node dist/cli.js ...` 调用。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "./agentd/daemon.js";
import { createExtractAdapters } from "./agentd/native-invoker.js";
import { createRotatingLogger } from "./agentd/logger.js";
import { emptyState, loadConfig, loadState, saveConfig, saveState } from "./agentd/state.js";
import { getGitState } from "./agentd/git-state.js";
import { repoKey } from "./repo-key.js";
import { deviceLogin, install, planInstall, status as statusReport, uninstall, type InstallDeps } from "./install.js";
import { runDoctor } from "./doctor.js";
import { runHookCommand } from "./hook.js";
import { startWriter, sendWriter, type WriterCommand, type WriterResult } from "./local/writer.js";
import { openStore, profilesDir, snapshotPath } from "./local/store.js";
import { setAccountDefaultSoul, setToolDefault } from "./local/bindings.js";
import type { ProfileId } from "./adapters/types.js";
import type { RuntimeKind } from "./assets/protocol.js";
import { RUNTIME_KINDS } from "./assets/protocol.js";
import "./local/bindings.js"; // side effect: register create_soul / edit_local_identity / bind / detach / export
import "./extraction/scheduler.js"; // side effect: register runtime_event / commit_extraction writer commands
import "./sync/client.js"; // side effect: register sync_once / record_receipt / review_asset / delete_asset
import { isAssetsModeSync } from "./sync/client.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
}

const USAGE = `37soul — local capture + continuity for your 37Soul character.

  37soul install [--agents claude-code,codex] [--plan] [--fallback codex]
                                                connect the agents on this machine
  37soul doctor                                  check configuration and credentials
  37soul status                                  show machine, tokens, last uploads
  37soul pause [--repo <path|repo-key>]          pause capture (all, or one repo)
  37soul resume                                  resume capture
  37soul uninstall                               remove hooks, instructions, service, data

  37soul login [--profile <id>]                  device login; merge the local anonymous profile
  37soul soul create --name <n> [--description <d>] [--character <c>] [--greeting <g>] [--profile <id>]
  37soul soul list [--profile <id>]              list local Souls
  37soul soul select <uid> [--agent <kind>] [--profile <id>]   set the default Soul
  37soul soul edit <uid> [--name <n> ...] [--profile <id>]     edit a local (unregistered) Soul
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
  const apiBase = (process.env.SOUL37_BASE_URL || "https://37soul.com").replace(/\/+$/, "");
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
  switch (command) {
    case "install": {
      const agents = flagValue(rest, "--agents")?.split(",").map((s) => s.trim()).filter(Boolean);
      const fallback = flagValue(rest, "--fallback")?.split(",").map((s) => s.trim()).filter(Boolean);
      // v2 §6.1：--plan 只打印要动哪些文件，不写入任何东西。
      if (rest.includes("--plan")) {
        const plan = await planInstall(deps, { agents });
        io.stdout(`would connect: ${plan.agents.join(", ") || "(none detected)"}\n`);
        io.stdout(`would touch:\n${plan.files.map((file) => `  ${file}`).join("\n")}\n`);
        if (plan.serviceFile) io.stdout(`would install the background service: ${plan.serviceFile}\n`);
        return 0;
      }
      const result = await install(deps, { agents, fallback });
      io.stdout(`\nConnected: ${result.installed.map((entry) => entry.agentKind).join(", ")}\n`);
      const doctor = await runDoctor(deps);
      for (const check of doctor.checks) {
        io.stdout(`${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}\n`);
      }
      io.stdout("\nCapture keeps running in the background; nothing else to do.\n");
      return doctor.ok ? 0 : 1;
    }
    case "doctor": {
      const doctor = await runDoctor(deps);
      for (const check of doctor.checks) {
        io.stdout(`${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}\n`);
      }
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
      return soulCommand(root, rest, io);
    case "bind":
      return bindCommand(root, rest, io, false);
    case "detach":
      return bindCommand(root, rest, io, true);
    case "login":
      return loginCommand(root, rest, io, deps);
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
    config?.api_base_url ?? (process.env.SOUL37_BASE_URL || "https://37soul.com").replace(/\/+$/, "");
  const machineId = config?.machine_id ?? legacyState.machine_id;
  // Upgrade gate: in assets mode the legacy transcript upload path must be inert —
  // pre-seeded spool/queue/log_turn/checkpoint/facts/remember/PAT updates produce
  // zero old write requests. With tokens forced to {} (and no transcript fallback),
  // `uploadBatch` short-circuits to "unauthorized" before any fetch and the spool is
  // never discovered. Local assets/soul data is untouched.
  const assetsMode = isAssetsModeSync(root);
  const tokens = assetsMode ? {} : (config?.tokens ?? {});

  const logger = createRotatingLogger({ file: path.join(root, "agentd.log") });
  const daemon = createDaemon(
    {
      root,
      apiBaseUrl,
      machineId,
      tokens,
      home,
      // v2 §6.2：hook 是主路径；会话记录兜底只对显式开启的 Agent 生效。
      transcriptFallback: assetsMode ? [] : (config?.transcript_fallback ?? []),
    },
    {
      log: logger,
      fetch: globalThis.fetch,
      getGitState,
      // Task 10: wire the four runtime adapters + spawn NativeInvoker into agentd's
      // assets-mode drain (only assets mode has extraction watermarks).
      extractAdapters: assetsMode ? createExtractAdapters(home, logger) : undefined,
    },
  );

  // Single-writer IPC for local soul assets. Best-effort: IPC unavailability must
  // never fail the user's working session.
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

function profileIdFromArgs(rest: string[]): string {
  return flagValue(rest, "--profile") ?? "default";
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

async function soulCommand(root: string, rest: string[], io: CliIO): Promise<number> {
  const [sub, ...args] = rest;
  const profileId = profileIdFromArgs(args);

  if (sub === "create") {
    const identity = {
      name: flagValue(args, "--name") ?? "Soul",
      description: flagValue(args, "--description") ?? "",
      character: flagValue(args, "--character") ?? "",
      greeting: flagValue(args, "--greeting") ?? "",
    };
    const res = await runWriterCommand(root, profileId, "create_soul", { identity });
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    const soul = res.result as { soul_uid: string };
    io.stdout(`created soul ${soul.soul_uid}\n`);
    return 0;
  }

  if (sub === "list") {
    const store = await openStore(root, profileId);
    let souls: Array<{ soul_uid: string; legacy_host_id: number | null; identity: { name: string } }> = [];
    try {
      souls = Object.values((await store.read()).souls);
    } finally {
      await store.close();
    }
    if (souls.length === 0) io.stdout("no local souls\n");
    for (const soul of souls) {
      const registered = soul.legacy_host_id !== null ? `  (registered host #${soul.legacy_host_id})` : "  (local)";
      io.stdout(`- ${soul.soul_uid}  ${soul.identity.name}${registered}\n`);
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
    let current: { identity: { name: string; description: string; character: string; greeting: string } } | undefined;
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
    const identity = {
      name: pick("--name", "name"),
      description: pick("--description", "description"),
      character: pick("--character", "character"),
      greeting: pick("--greeting", "greeting"),
    };
    const res = await runWriterCommand(root, profileId, "edit_local_identity", { soul_uid: soulUid, identity });
    if (!res.ok) {
      io.stderr(`${res.error.code}: ${res.error.message}\n`);
      return 1;
    }
    io.stdout(`updated soul ${soulUid}\n`);
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

export async function bindCommand(root: string, rest: string[], io: CliIO, detach: boolean): Promise<number> {
  const profileId = profileIdFromArgs(rest);
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
    io.stderr("this session already has a different soul injected; start a new session to switch\n");
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

async function readClientVersion(cliScriptPath: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(path.dirname(cliScriptPath), "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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
    if (snap.owner_id !== ownerId) continue;
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

export async function loginCommand(
  root: string,
  rest: string[],
  io: CliIO,
  deps: InstallDeps,
): Promise<number> {
  const profileId = profileIdFromArgs(rest);
  const machineId = await readProfileDeviceId(root, profileId);
  const clientVersion = await readClientVersion(fileURLToPath(import.meta.url));

  const login = await deviceLogin(deps, [...RUNTIME_KINDS], { assetsMode: true, machineId, clientVersion });

  if (!login.owner_id) {
    io.stderr("login returned no owner_id\n");
    return 1;
  }

  // User-visible rule: if the same owner already has local profiles, never merge or
  // switch silently. List the candidates and require an explicit flag.
  const mergeProfileId = flagValue(rest, "--merge-profile");
  const useProfileId = flagValue(rest, "--use-profile");
  if (mergeProfileId && useProfileId) {
    io.stderr("--merge-profile and --use-profile are mutually exclusive\n");
    return 2;
  }
  const candidates = await listSameOwnerProfiles(root, login.owner_id, profileId);
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
  // Persist the device tokens the login just granted (merged, never replacing the
  // other agents' tokens) so the local soul sync has an authorized device token to
  // push/pull with. Tokens are written to config.json only — never the snapshot,
  // outbox, receipt, error, log or CLI output.
  const existing = await loadConfig(root);
  if (existing && login.tokens && Object.keys(login.tokens).length > 0) {
    await saveConfig(root, { ...existing, tokens: { ...(existing.tokens ?? {}), ...login.tokens } });
  }

  // Print the profile actually adopted (the writer result), never the current/anonymous
  // id — so the success line can never disagree with accounts.json.
  const adopted = res.result as { profile_id?: unknown; owner_id?: unknown } | null;
  const adoptedProfile = adopted && typeof adopted.profile_id === "string" ? adopted.profile_id : profileId;
  const adoptedOwner = adopted && typeof adopted.owner_id === "string" ? adopted.owner_id : login.owner_id;
  io.stdout(`logged in as owner ${adoptedOwner} (profile ${adoptedProfile})\n`);
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
