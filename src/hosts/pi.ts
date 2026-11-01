import path from "node:path";
import { inspectPiExtension, piExtensionPath, removePiExtension, writePiExtension, createPiAdapter } from "../adapters/pi.js";
import type { HostSpec, HostInstallDeps, HostInstallResult, HostDoctorDeps, HostDoctorCheck } from "./types.js";
import { parseHookPayload, manifestSha256 } from "./shared.js";

async function configurePi(
  deps: HostInstallDeps,
): Promise<HostInstallResult> {
  const written = writePiExtension(deps.home);
  const inspection = inspectPiExtension(deps.home);
  return {
    manifestEntries: [
      { agent: "pi", file: written.path, kind: "pi_extension", generation: written.generation, sha256: written.sha256 },
    ],
    hook: false, // 没有全局 hook：事件由扩展桥转给本地 hook 命令
    instructions: false, // 扩展文件是唯一受管产物
    mcp: false,
    report: {
      installed: written.installed,
      trusted: false, // Pi 没有可读的“已加载”标记，我们不猜
      events_seen: false,
      extraction_capable: false,
      injection_capable: false,
      generation: written.generation,
    },
  };
}

async function uninstall(deps: HostInstallDeps, removed: string[]): Promise<void> {
  // 2e. Pi 扩展桥（ONE 受管静态文件；只删声明了我们 generation 的那一个）。
  const piSha = await manifestSha256(deps.home, "pi_extension");
  const piRemoval = removePiExtension(deps.home, { expectedSha256: piSha });
  if (piRemoval.removed) removed.push(path.relative(deps.home, piExtensionPath(deps.home)));
  if (piRemoval.preserved) {
    deps.log?.(`  kept ${piExtensionPath(deps.home)} (unreadable or not ours) — remove it by hand if it is 37soul's`);
  }
}

async function doctor(_deps: HostDoctorDeps): Promise<HostDoctorCheck[]> {
  // Pi had no per-host configuration checks before the registry refactor.
  return [];
}

export const host: HostSpec = {
  kind: "pi",
  label: "Pi",
  home: ".pi",
  level: "capture",
  hook: {
    events: [{ event: "SessionStart" }, { event: "UserPromptSubmit" }, { event: "PostToolUse" }, { event: "PostToolUseFailure" }, { event: "Stop" }, { event: "SessionEnd" }],
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseHookPayload,
  },
  install: {
    plan: ({ home }) => [piExtensionPath(home)],
    configure: configurePi,
    uninstall,
  },
  doctor,
  invoke: { binary: "pi", createAdapter: createPiAdapter },
};
