import type { HostSpec } from "./types.js";
import { host as claudeCode } from "./claude-code.js";
import { host as codex } from "./codex.js";
import { host as openCode } from "./opencode.js";
import { host as hermes } from "./hermes.js";
import { host as pi } from "./pi.js";
import { host as geminiCli } from "./gemini-cli.js";
import { host as cursor } from "./cursor.js";

/** Canonical host order: detection, plans, manifests and cleanup rely on it. */
export const HOSTS: readonly HostSpec[] = [claudeCode, codex, openCode, hermes, pi, geminiCli, cursor];

export function hostSpec(kind: string): HostSpec | undefined {
  return HOSTS.find((host) => host.kind === kind);
}

export const SUPPORTED_AGENTS: readonly string[] = HOSTS.map((host) => host.kind);
export const AGENT_HOMES: Record<string, string> = {
  ...Object.fromEntries(HOSTS.map((host) => [host.kind, host.home])),
};
