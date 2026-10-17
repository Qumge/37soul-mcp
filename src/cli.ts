#!/usr/bin/env node
/**
 * `37soul` CLI（设计 §6.1）：install / doctor / status / uninstall / pause / resume，
 * 以及两个内部命令 `agentd`（后台采集进程）和 `hook --agent <kind>`（SessionStart）。
 *
 * npm 发布是独立的一步：在包名发布完成之前，本地用 `node dist/cli.js ...` 调用。
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemon } from "./agentd/daemon.js";
import { createRotatingLogger } from "./agentd/logger.js";
import { emptyState, loadConfig, loadState, saveState } from "./agentd/state.js";
import { getGitState } from "./agentd/git-state.js";
import { repoKey } from "./repo-key.js";
import { install, planInstall, status as statusReport, uninstall } from "./install.js";
import { runDoctor } from "./doctor.js";
import { runHookCommand } from "./hook.js";

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
  if (!config) {
    io.stderr("37soul is not installed here — run `37soul install` first\n");
    return 1;
  }

  const logger = createRotatingLogger({ file: path.join(root, "agentd.log") });
  const daemon = createDaemon(
    {
      root,
      apiBaseUrl: config.api_base_url,
      machineId: config.machine_id,
      tokens: config.tokens,
      home,
      // v2 §6.2：hook 是主路径；会话记录兜底只对显式开启的 Agent 生效。
      transcriptFallback: config.transcript_fallback ?? [],
    },
    { log: logger, fetch: globalThis.fetch, getGitState },
  );

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
