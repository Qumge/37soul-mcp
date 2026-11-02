import path from "node:path";
import { readRuntimeEvidence, runtimeEvidenceChecks } from "./runtime-evidence.js";
import { detectHermesSurface, inspectHermesPlugin, hermesPluginPath, removeHermesPlugin, writeHermesPlugin, createHermesAdapter, latestHermesCompletedTurnRefs } from "../adapters/hermes.js";
import type { HostSpec, HostInstallDeps, HostInstallResult, HostDoctorDeps, HostDoctorCheck } from "./types.js";
import { parseHookPayload, manifestSha256 } from "./shared.js";

async function configureHermes(
  deps: HostInstallDeps,
  _token: string,
): Promise<HostInstallResult> {
  // Hermes 走 Python 桥（Task 9）：只写 ONE 受管静态 .py 文件，注入经桥在下一个
  // request 边界投递。桥未验证，所以 trusted/events/extraction/injection 都不绿；
  // 不写全局 hook、不写 instructions fragment、不注册 MCP —— 桥文件是唯一受管产物。
  // 我们自己的写文件永远不能把 trusted 变绿。gateway-only 配置绝不冒充 CLI 能力，
  // 只把它诚实地记进 report.surface（doctor 会显式说出来）。
  const surface = detectHermesSurface(deps.home);
  const written = writeHermesPlugin(deps.home);
  return {
    // Preserve the legacy second managed write at manifest time, after service/bin setup.
    get manifestEntries() {
      const entry = writeHermesPlugin(deps.home);
      return [{ agent: "hermes", file: entry.path, kind: "hermes_plugin", sha256: entry.sha256 }];
    },
    hook: false, // no global hook: injection arrives via the Python bridge at the next request boundary
    instructions: false, // no AGENTS fragment for Hermes; the bridge file is the only managed artifact
    mcp: false,
    report: {
      installed: written.installed, // our own bridge-file write
      trusted: false, // no Hermes-authored load/trust marker
      events_seen: false, // never observed
      extraction_capable: false, // no verified native command (P0 未验)
      injection_capable: false, // Python bridge unverified
      surface,
    },
  };
}

async function uninstall(deps: HostInstallDeps, removed: string[]): Promise<void> {
  // 2d. Hermes Python 桥（ONE 受管静态文件；只删这一条，别的 vendor 插件不动）。
  // 哈希感知：只删没被改过的受管文件；被用户/Hermes 改过的先备份再删，读不了就保留。
  const hermesSha = await manifestSha256(deps.home, "hermes_plugin");
  const hermesRemoval = removeHermesPlugin(deps.home, { expectedSha256: hermesSha });
  if (hermesRemoval.removed) removed.push(path.relative(deps.home, hermesPluginPath(deps.home)));
  if (hermesRemoval.preserved) {
    deps.log?.(`  kept ${hermesPluginPath(deps.home)} (unreadable) — remove it by hand if it is 37soul's`);
  }
}

async function doctor(deps: HostDoctorDeps): Promise<Array<HostDoctorCheck & { waiting?: boolean }>> {
  const agentKind = "hermes";
  const checks: Array<HostDoctorCheck & { waiting?: boolean }> = [];
  const inspection = inspectHermesPlugin(deps.home);
  if (inspection.status !== "observation_only") {
    checks.push({ name: `${agentKind}: plugin bridge`, ok: false, detail: hermesDoctorDetail(inspection) });
    return checks;
  }
  const evidence = await readRuntimeEvidence(deps.home, "hermes");
  const observed = evidence.hook_output_observed || evidence.extraction_completed;
  checks.push({ name: `${agentKind}: plugin bridge`, ok: observed, waiting: !observed,
    detail: observed
      ? "Installed bridge with matching local runtime evidence observed; Hermes trust and official shell-hook consent are not inferred from installation. These observations do not prove model adoption."
      : "Installed bridge; matching local runtime evidence not observed. Review the managed pre_llm_call/post_llm_call hooks in ~/.hermes/config.yaml, then use Hermes's official consent prompts to approve shell-hook execution; restart Hermes or start a new session. Trust is not inferred from installation. Run `37soul doctor` again." });
  checks.push(...runtimeEvidenceChecks("hermes", evidence));
  return checks;
}

function hermesDoctorDetail(inspection: { status: string; surface: string }): string {
  switch (inspection.status) {
    case "gateway_only":
      return "Hermes config declares a gateway-only surface — this is not a CLI model capability, so structured extraction stays off";
    case "not_installed":
      return "plugin bridge not installed — run `37soul install`";
    case "observation_only":
      return "Installed bridge; awaiting matching local runtime evidence.";
    default:
      return inspection.status;
  }
}

export const host: HostSpec = {
  kind: "hermes",
  label: "Hermes",
  home: ".hermes",
  hook: {
    events: [{ event: "SessionStart" }, { event: "UserPromptSubmit" }, { event: "Stop" }],
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseHookPayload,
    completedTurnRefs: (transcript) => latestHermesCompletedTurnRefs(transcript).refs,
  },
  install: {
    plan: ({ home }) => [hermesPluginPath(home)],
    configure: configureHermes,
    uninstall,
  },
  doctor,
  invoke: { binary: "hermes", userLaunchers: [".local/bin/hermes", ".hermes/venv/bin/hermes"], createAdapter: createHermesAdapter },
};
