import path from "node:path";
import { readRuntimeEvidence, runtimeEvidenceChecks } from "./runtime-evidence.js";
import { inspectOpenCodePlugin, openCodePluginPath, removeOpenCodePlugin, writeOpenCodePlugin, createOpenCodeAdapter, latestOpenCodeCompletedTurnRefs } from "../adapters/opencode.js";
import type { HostSpec, HostInstallDeps, HostInstallResult, HostDoctorDeps, HostDoctorCheck } from "./types.js";
import { parseHookPayload, manifestSha256 } from "./shared.js";

async function configureOpenCode(
  deps: HostInstallDeps,
  _token: string,
): Promise<HostInstallResult> {
  // OpenCode 走插件桥（Task 8）：只写 ONE 受管静态文件，注入经插件桥在下一个
  // request 边界投递。插件桥未验证，所以 trusted/events/extraction/injection 都
  // 不绿；不写全局 hook、不写 instructions fragment、不注册 MCP —— 插件文件是
  // 唯一受管产物。我们自己的写文件永远不能把 trusted 变绿。
  const written = writeOpenCodePlugin(deps.home);
  const inspection = inspectOpenCodePlugin(deps.home);
  const observedByOpenCode = inspection.status === "observation_only" || inspection.status === "model_refused";
  return {
    // Preserve the legacy second managed write at manifest time, after service/bin setup.
    get manifestEntries() {
      const entry = writeOpenCodePlugin(deps.home);
      return [{ agent: "opencode", file: entry.path, kind: "opencode_plugin", generation: entry.generation, sha256: entry.sha256 }];
    },
    hook: false, // no global hook: injection arrives via the plugin bridge at the next request boundary
    instructions: false, // no AGENTS fragment for OpenCode; the plugin file is the only managed artifact
    mcp: false,
    report: {
      installed: written.installed, // our own plugin-file write
      trusted: observedByOpenCode, // OpenCode-authored load+trust markers only
      events_seen: false, // never observed
      extraction_capable: false, // no verified native command (P0 未验)
      injection_capable: false, // plugin bridge unverified
      generation: written.generation,
    },
  };
}

async function uninstall(deps: HostInstallDeps, removed: string[]): Promise<void> {
  // 2c. OpenCode 插件桥（ONE 受管静态文件；只删这一条，别的 vendor 插件不动）。
  // 哈希感知：只删没被改过的受管文件；被用户/OpenCode 改过的先备份再删，读不了就保留。
  const pluginSha = await manifestSha256(deps.home, "opencode_plugin");
  const pluginRemoval = removeOpenCodePlugin(deps.home, { expectedSha256: pluginSha });
  if (pluginRemoval.removed) removed.push(path.relative(deps.home, openCodePluginPath(deps.home)));
  if (pluginRemoval.preserved) {
    deps.log?.(`  kept ${openCodePluginPath(deps.home)} (unreadable) — remove it by hand if it is 37soul's`);
  }
}

async function doctor(deps: HostDoctorDeps): Promise<Array<HostDoctorCheck & { waiting?: boolean }>> {
  const agentKind = "opencode";
  const checks: Array<HostDoctorCheck & { waiting?: boolean }> = [];
  const inspection = inspectOpenCodePlugin(deps.home);
  if (inspection.status === "not_installed" || inspection.status === "unsupported_generation") {
    checks.push({ name: `${agentKind}: plugin bridge`, ok: false, detail: openCodeDoctorDetail(inspection) });
    return checks;
  }
  const evidence = await readRuntimeEvidence(deps.home, "opencode");
  const observed = evidence.hook_output_observed || evidence.extraction_completed;
  const refusal = inspection.status === "model_refused" ? " The host reports a model refused state; hook output is not proof of completed extraction." : "";
  checks.push({ name: `${agentKind}: plugin bridge`, ok: observed, waiting: !observed,
    detail: (observed
      ? "Installed plugin with matching local runtime evidence observed; OpenCode trust is not inferred from installation. These observations do not prove model adoption."
      : "Installed plugin; matching local runtime evidence not observed. Review and enable the 37soul plugin in ~/.config/opencode/plugins, approve it through OpenCode if prompted, then restart OpenCode and open a new session. Loading and trust are not inferred from installation. Run `37soul doctor` again.") + refusal });
  checks.push(...runtimeEvidenceChecks("opencode", evidence));
  return checks;
}

function openCodeDoctorDetail(inspection: { status: string; declared: string }): string {
  switch (inspection.status) {
    case "not_installed":
      return "plugin bridge not installed — run `37soul install`";
    case "unsupported_generation":
      return `plugin bridge declares an unsupported generation (${inspection.declared || "none"}) — rerun \`37soul install\``;
    default:
      return inspection.status;
  }
}

export const host: HostSpec = {
  kind: "opencode",
  label: "OpenCode",
  home: ".config/opencode",
  hook: {
    events: [{ event: "SessionStart" }, { event: "UserPromptSubmit" }, { event: "Stop" }],
    injectionChannel: "SessionStart",
    emitsRuntimeEvents: true,
    parsePayload: parseHookPayload,
    completedTurnRefs: (transcript) => latestOpenCodeCompletedTurnRefs(transcript).refs,
  },
  install: {
    plan: ({ home }) => [openCodePluginPath(home)],
    configure: configureOpenCode,
    uninstall,
  },
  doctor,
  invoke: { binary: "opencode", userLaunchers: [".opencode/bin/opencode", ".local/bin/opencode"], requiredMajor: 2, createAdapter: createOpenCodeAdapter },
};
