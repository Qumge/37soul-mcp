/**
 * Kiro CLI V3 standalone hooks: one global JSON file with a versioned `hooks`
 * array. Each entry is a command action and stdout from SessionStart /
 * UserPromptSubmit is added to the session context as plain text.
 *
 * Only our marked entries are ever changed. User hooks, other root keys and a
 * user-disabled/renamed managed hook survive the edit; an unreadable or
 * incompatible file is preserved and reported rather than repaired.
 */
import path from "node:path";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { editJsonFile } from "../config-editor.js";
import { KIRO_EXTRACTION_BLOCKER } from "../adapters/kiro.js";
import { nativeHookCommandFor } from "./native-json-hooks.js";
import { readRuntimeEvidence, runtimeEvidenceChecks } from "./runtime-evidence.js";
import type { HostDoctorCheck, HostDoctorDeps, HostInstallDeps, HostInstallResult } from "./types.js";

export const KIRO_HOOK_EVENTS = [
  { event: "SessionStart", canonical: "SessionStart" },
  { event: "UserPromptSubmit", canonical: "UserPromptSubmit" },
] as const;

export const KIRO_HOOK_FILE = [".kiro", "hooks", "37soul.json"] as const;
const TIMEOUT_SECONDS = 30;

type KiroEvent = (typeof KIRO_HOOK_EVENTS)[number];

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function filePath(home: string): string {
  return path.join(home, ...KIRO_HOOK_FILE);
}

function validate(document: unknown): asserts document is Record<string, any> {
  if (!object(document)) throw new Error("kiro: hooks config must be a JSON object");
  if (document.version !== undefined && document.version !== "v1") {
    throw new Error("kiro: unsupported hooks config version (expected v1); preserved unchanged");
  }
  if (document.hooks !== undefined && !Array.isArray(document.hooks)) {
    throw new Error("kiro: hooks must be an array");
  }
}

function managed(entry: any, event: KiroEvent): boolean {
  return entry?.action?.type === "command" && typeof entry.action.command === "string" &&
    entry.action.command.includes(` hook --agent kiro --event ${event.canonical} `) &&
    entry.action.command.endsWith(` # 37soul-managed:kiro:${event.event}:v1`);
}

function managedFor(document: Record<string, any>, event: KiroEvent): any[] {
  return (Array.isArray(document.hooks) ? document.hooks : []).filter((entry: any) => managed(entry, event));
}

function entryFor(
  deps: Pick<HostInstallDeps, "launcher" | "nodePath" | "cliScriptPath">,
  event: KiroEvent,
  previous?: any,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    name: typeof previous?.name === "string" && previous.name.trim() !== ""
      ? previous.name
      : `37soul-kiro-${event.event}`,
    trigger: event.canonical,
    action: { type: "command", command: nativeHookCommandFor(deps, "kiro", event) },
    timeout: TIMEOUT_SECONDS,
    // Disabling our entry is a user decision; reinstalling must not silently undo it.
    enabled: typeof previous?.enabled === "boolean" ? previous.enabled : true,
  };
  if (typeof previous?.description === "string") entry.description = previous.description;
  return entry;
}

export function kiroHookPlan(home: string): string[] {
  return [filePath(home)];
}

export async function configureKiroHooks(deps: HostInstallDeps): Promise<HostInstallResult> {
  const file = filePath(deps.home);
  // Validate before mkdir or backup, including the root and version shapes.
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = {};
  }
  validate(existing);
  await mkdir(path.dirname(file), { recursive: true });
  await editJsonFile(file, document => {
    validate(document);
    const before = JSON.stringify(document);
    document.version = "v1";
    const hooks: any[] = Array.isArray(document.hooks) ? document.hooks : [];
    for (const event of KIRO_HOOK_EVENTS) {
      const previous = managedFor(document, event)[0];
      const kept = hooks.filter((entry: any) => !managed(entry, event));
      kept.push(entryFor(deps, event, previous));
      hooks.splice(0, hooks.length, ...kept);
    }
    document.hooks = hooks;
    return JSON.stringify(document) !== before;
  });
  deps.log?.(`  kiro: hooks configured; trust/load, injection and extraction are not verified. ${KIRO_EXTRACTION_BLOCKER}`);
  return {
    hook: true,
    instructions: false,
    mcp: false,
    report: { installed: true, trusted: false, events_seen: false, extraction_capable: false, injection_capable: false },
    manifestEntries: [{ agent: "kiro", file, kind: "hooks", events: KIRO_HOOK_EVENTS.map(event => event.event) }],
  };
}

export async function uninstallKiroHooks(deps: HostInstallDeps, removed: string[]): Promise<void> {
  const file = filePath(deps.home);
  try {
    let empty = false;
    const result = await editJsonFile(file, document => {
      validate(document);
      if (!Array.isArray(document.hooks)) return false;
      const before = JSON.stringify(document.hooks);
      const kept = document.hooks.filter((entry: any) => !KIRO_HOOK_EVENTS.some(event => managed(entry, event)));
      if (JSON.stringify(kept) === before) return false;
      document.hooks = kept;
      empty = kept.length === 0 && Object.keys(document).every(key => key === "version" || key === "hooks");
      return true;
    });
    if (!result.changed) return;
    if (empty) await unlink(file);
    removed.push(path.relative(deps.home, file));
  } catch {
    deps.log?.(`  kept ${file} (unreadable or incompatible configuration); no user hooks removed`);
  }
}

export async function doctorKiroHooks(deps: HostDoctorDeps): Promise<HostDoctorCheck[]> {
  const file = filePath(deps.home);
  let current = false;
  let detail = "missing or invalid native hook configuration";
  try {
    const document: unknown = JSON.parse(await readFile(file, "utf8"));
    validate(document);
    let disabled = false;
    const expected = KIRO_HOOK_EVENTS.map(event => {
      const own = managedFor(document, event);
      if (own.length !== 1) return false;
      const hook = own[0];
      if (hook.trigger !== event.canonical || hook.action?.type !== "command") return false;
      if (hook.action.command !== nativeHookCommandFor(
        { ...deps, launcher: deps.config.launcher },
        "kiro",
        event,
      )) return false;
      if (hook.enabled === false) disabled = true;
      return true;
    }).every(Boolean);
    current = expected && !disabled;
    detail = disabled
      ? "hooks disabled by user configuration; preserved unchanged"
      : expected
        ? `Native subscriptions present at ${file}; configuration alone does not prove host loading or execution.`
        : "missing, duplicate or stale native subscriptions; rerun 37soul install";
  } catch { /* Read-only diagnostics; never create or repair configuration. */ }
  const evidence = await readRuntimeEvidence(deps.home, "kiro");
  return [
    { name: "kiro: native hook configuration", ok: current, detail },
    { name: "kiro: trust/load", ok: false, detail: "Host trust/load is not verified. A config write or hook-output receipt does not prove host trust or model adoption." },
    ...runtimeEvidenceChecks("kiro", evidence).map(check => check.name.endsWith(": extraction") && !check.ok
      ? { ...check, detail: `${check.detail} ${KIRO_EXTRACTION_BLOCKER}` }
      : check),
  ];
}
