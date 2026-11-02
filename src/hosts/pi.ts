import path from "node:path";
import { inspectPiExtension, piExtensionPath, removePiExtension, writePiExtension, createPiAdapter, latestPiCompletedTurnRefs } from "../adapters/pi.js";
import type { HostSpec, HostInstallDeps, HostInstallResult, HostDoctorDeps, HostDoctorCheck } from "./types.js";
import { parseHookPayload, manifestSha256 } from "./shared.js";

async function configurePi(
  deps: HostInstallDeps,
): Promise<HostInstallResult> {
  const written = writePiExtension(deps.home);
  const inspection = inspectPiExtension(deps.home);
  return {
    // Preserve the legacy second managed write at manifest time, after service/bin setup.
    get manifestEntries() {
      const entry = writePiExtension(deps.home);
      return [{ agent: "pi", file: entry.path, kind: "pi_extension", generation: entry.generation, sha256: entry.sha256 }];
    },
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

async function doctor(deps: HostDoctorDeps): Promise<Array<HostDoctorCheck & { waiting?: boolean }>> {
  const inspection = inspectPiExtension(deps.home);
  const name = "pi: extension bridge";
  const recovery = "Run 37soul install to reinstall the Pi extension, then restart Pi and open a new session.";
  if (inspection.status === "not_installed") {
    return [{ name, ok: false, detail: `Not installed: missing ${inspection.path}. ${recovery}` }];
  }
  if (inspection.status === "generation_unsupported") {
    return [{ name, ok: false, detail: `Unsupported extension generation at ${inspection.path}: ${inspection.detail}. ${recovery}` }];
  }
  if (inspection.detail) {
    return [{ name, ok: false, detail: `Cannot read extension at ${inspection.path}: ${inspection.detail}. ${recovery}` }];
  }
  // Our managed file proves installation only. No Pi-authored load/trust marker
  // is available here; generic hook activity alone cannot prove this file loaded
  // or that native extraction succeeded. Never promote a file write to green.
  return [{
    name,
    ok: false,
    waiting: true,
    detail: `Extension present at ${inspection.path} (${inspection.generation}); waiting for runtime evidence. ` +
      "Restart Pi and open a new session to load the extension and emit native events. " +
      "Loading and trust are not verified; injection and extraction are not verified. " +
      "A managed file alone does not prove that Pi loaded or executed it.",
  }];
}

export const host: HostSpec = {
  kind: "pi",
  label: "Pi",
  home: ".pi",
  hook: {
    events: [{ event: "SessionStart" }, { event: "UserPromptSubmit" }, { event: "PostToolUse" }, { event: "PostToolUseFailure" }, { event: "Stop" }, { event: "SessionEnd" }],
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseHookPayload,
    completedTurnRefs: latestPiCompletedTurnRefs,
  },
  install: {
    plan: ({ home }) => [piExtensionPath(home)],
    configure: configurePi,
    uninstall,
  },
  doctor,
  invoke: { binary: "pi", createAdapter: createPiAdapter },
};
