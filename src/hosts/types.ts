import type { RuntimeKind } from "../assets/protocol.js";
import type { AdapterDeps, RuntimeAdapter } from "../adapters/types.js";
import type { RunCommand } from "../service.js";
import type { AgentConfig } from "../agentd/state.js";

export type InjectionChannel = "SessionStart" | "UserPromptSubmit" | "none";

export interface HostInstallDeps {
  home: string;
  apiBase: string;
  launcher?: string;
  /** Preserve the pre-runtime hookCommand fallback used by existing callers. */
  nodePath: string;
  cliScriptPath: string;
  runCommand: RunCommand;
  log?: (line: string) => void;
}

export interface CodexInstallReport {
  /** We wrote our own hook subscription (a config write we performed). */
  installed: boolean;
  /** Codex-authored trust marker only; a write we performed never flips this. */
  trusted: boolean;
  /** Never observed: stays false even when a Codex-authored trust marker exists, because there is no event-observation path. */
  events_seen: boolean;
  /** No verified native command (P0 matrix row stays 未验). */
  extraction_capable: boolean;
  /** Injection needs a trusted SessionStart hook. */
  injection_capable: boolean;
}

export interface OpenCodeInstallReport {
  /** We wrote the ONE managed plugin file (a file write we performed). */
  installed: boolean;
  /** OpenCode-authored load+trust markers only; a write we performed never flips this. */
  trusted: boolean;
  /** Never observed: stays false (no event-observation path). */
  events_seen: boolean;
  /** No verified native command (P0 matrix row stays 未验). */
  extraction_capable: boolean;
  /** The plugin bridge is unverified, so injection is never claimed. */
  injection_capable: boolean;
  /** The plugin generation the installed file declares. */
  generation: "v1" | "v2" | "pi-extension-v1" | "unsupported";
}

export interface HermesInstallReport {
  /** We wrote the ONE managed Python bridge file (a file write we performed). */
  installed: boolean;
  /** No Hermes-authored trust/load marker: a write we performed never flips this. */
  trusted: boolean;
  /** Never observed: stays false (no event-observation path). */
  events_seen: boolean;
  /** No verified native command (P0 matrix row stays 未验). */
  extraction_capable: boolean;
  /** The Python bridge is unverified, so injection is never claimed. */
  injection_capable: boolean;
  /** The Hermes config surface detected at install time (gateway is never CLI). */
  surface: "gateway" | "cli" | "none";
}

export interface HostInstallResult {
  hook: boolean;
  instructions: boolean;
  mcp: boolean;
  report?: CodexInstallReport | OpenCodeInstallReport | HermesInstallReport;
  /** Read once at manifest time; bridges preserve their historical second managed write. */
  manifestEntries: Array<Record<string, unknown>>;
}

export interface HostHookPayload {
  sessionId: string;
  cwd?: string;
  prompt?: string;
  transcriptPath: string | null;
}

export interface HostHookSpec {
  events: ReadonlyArray<{ event: string; matcher?: string }>;
  injectionChannel: InjectionChannel;
  emitsRuntimeEvents: boolean;
  parsePayload(payload: Record<string, any>): HostHookPayload;
  completedTurnRefs?(transcript: string): string[];
}

export interface HostDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fatal?: boolean;
}

export interface HostDoctorDeps {
  home: string;
  config: AgentConfig;
  assetsMode: boolean;
  /** Used only when the installed config has no fixed runtime launcher. */
  nodePath: string;
  cliScriptPath: string;
}

export interface HostInstallSpec {
  plan(deps: Pick<HostInstallDeps, "home">): string[];
  configure(deps: HostInstallDeps, token: string): Promise<HostInstallResult>;
  uninstall(deps: HostInstallDeps, removed: string[]): Promise<void>;
  mcpRemoveCommands?: ReadonlyArray<readonly string[]>;
}

export interface HostInvokeSpec {
  binary: string;
  /** Ordered stable launcher paths relative to the user home; never version-directory scans. */
  userLaunchers: readonly string[];
  /** Reject another CLI generation before passing extraction arguments. */
  requiredMajor?: number;
  createAdapter(deps: AdapterDeps): RuntimeAdapter;
}

export interface HostSpec {
  kind: RuntimeKind;
  label: string;
  home: string;
  hook: HostHookSpec;
  install: HostInstallSpec;
  doctor(deps: HostDoctorDeps): Promise<HostDoctorCheck[]>;
  invoke?: HostInvokeSpec;
}
