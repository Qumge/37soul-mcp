/** Gemini/Cursor config surgery only. Never enables hooks or changes host trust. */
import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { editJsonFile } from "../config-editor.js";
import { readRuntimeEvidence, runtimeEvidenceChecks } from "./runtime-evidence.js";
import type { HostDoctorCheck, HostDoctorDeps, HostInstallDeps, HostInstallResult } from "./types.js";

type NativeKind = "gemini-cli" | "cursor";
export interface NativeHookEvent { event: string; canonical: string }
export interface NativeHookConfig {
  kind: NativeKind;
  relativeFile: readonly string[];
  grouped: boolean;
  events: readonly NativeHookEvent[];
  extractionBlocker: string;
}

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validate(document: unknown, spec: NativeHookConfig): asserts document is Record<string, any> {
  if (!object(document)) throw new Error(`${spec.kind}: config must be a JSON object`);
  if (spec.kind === "cursor" && document.version !== undefined && document.version !== 1) {
    throw new Error("cursor: unsupported hooks config version (expected 1); preserved unchanged");
  }
  if (document.hooks !== undefined && !object(document.hooks)) throw new Error(`${spec.kind}: hooks must be an object`);
  for (const { event } of spec.events) {
    const entries = document.hooks?.[event];
    if (entries !== undefined && !Array.isArray(entries)) throw new Error(`${spec.kind}: ${event} hooks must be an array`);
  }
}

/** POSIX shell argument quoting; JSON escaping is not shell escaping. */
function quote(value: string): string {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw new Error("native hook launcher path contains a control character");
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function nativeHookCommandFor(
  deps: Pick<HostInstallDeps, "launcher" | "nodePath" | "cliScriptPath">,
  kind: string,
  event: { event: string; canonical: string },
): string {
  const prefix = deps.launcher ? quote(deps.launcher) : `${quote(deps.nodePath)} ${quote(deps.cliScriptPath)}`;
  return `${prefix} hook --agent ${kind} --event ${event.canonical} # 37soul-managed:${kind}:${event.event}:v1`;
}

export function nativeHookCommand(deps: Pick<HostInstallDeps, "launcher" | "nodePath" | "cliScriptPath">, spec: NativeHookConfig, event: NativeHookEvent): string {
  return nativeHookCommandFor(deps, spec.kind, event);
}

function managed(entry: any, spec: NativeHookConfig, event: NativeHookEvent): boolean {
  return entry?.type === "command" && typeof entry.command === "string" &&
    entry.command.includes(` hook --agent ${spec.kind} --event ${event.canonical} `) &&
    entry.command.endsWith(` # 37soul-managed:${spec.kind}:${event.event}:v1`);
}

/** Keep user hooks even when they share a Gemini group with one of ours. */
function withoutManaged(entries: any[], spec: NativeHookConfig, event: NativeHookEvent): any[] {
  if (!spec.grouped) return entries.filter(entry => !managed(entry, spec, event));
  return entries.flatMap(entry => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook: any) => !managed(hook, spec, event));
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  });
}

function filePath(home: string, spec: NativeHookConfig): string {
  return path.join(home, ...spec.relativeFile);
}

export function nativeHookPlan(home: string, spec: NativeHookConfig): string[] {
  return [filePath(home, spec)];
}

function subscriptions(deps: Pick<HostInstallDeps, "launcher" | "nodePath" | "cliScriptPath">, spec: NativeHookConfig) {
  return spec.events.map(event => {
    const hook = { type: "command", command: nativeHookCommand(deps, spec, event), timeout: spec.grouped ? 5000 : 5 };
    return { event, entry: spec.grouped ? { hooks: [{ ...hook, name: `37soul-${spec.kind}-${event.event}` }] } : hook };
  });
}

export async function configureNativeHooks(deps: HostInstallDeps, spec: NativeHookConfig): Promise<HostInstallResult> {
  const file = filePath(deps.home, spec);
  // Validate before mkdir or backup, including the root JSON type and host version.
  let existing: unknown;
  try { existing = JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = {};
  }
  validate(existing, spec);
  await mkdir(path.dirname(file), { recursive: true });
  await editJsonFile(file, document => {
    validate(document, spec);
    const before = JSON.stringify(document);
    document.hooks ??= {};
    if (spec.kind === "cursor") document.version ??= 1;
    for (const { event, entry } of subscriptions(deps, spec)) {
      const previous = document.hooks[event.event] ?? [];
      if (spec.grouped) {
        const own = previous.flatMap((group: any) => Array.isArray(group?.hooks) ? group.hooks : [])
          .filter((hook: any) => managed(hook, spec, event));
        if (own.length > 0) {
          const hook = (entry as any).hooks[0];
          // Gemini identifies hooks by name || command. Preserve user renames
          // and deliberately unnamed hooks instead of assigning a new identity.
          if (Object.hasOwn(own[0], "name")) hook.name = own[0].name;
          else delete hook.name;
          const disabled = document.hooksConfig?.disabled;
          if (Array.isArray(disabled) && own.some((old: any) => disabled.includes(old.name || old.command))) {
            const identity = hook.name || hook.command;
            // An unnamed disabled command changes identity on launcher upgrades.
            // Retain old/user entries and add only the new disabled identity.
            if (!disabled.includes(identity)) disabled.push(identity);
          }
        }
      }
      const list = withoutManaged(previous, spec, event);
      document.hooks[event.event] = [...list, entry];
    }
    return JSON.stringify(document) !== before;
  });
  deps.log?.(`  ${spec.kind}: hooks configured; trust/load, injection and extraction are not verified. ${spec.extractionBlocker}`);
  return {
    hook: true,
    instructions: false,
    mcp: false,
    report: { installed: true, trusted: false, events_seen: false, extraction_capable: false, injection_capable: false },
    manifestEntries: [{ agent: spec.kind, file, kind: "hooks", events: spec.events.map(event => event.event) }],
  };
}

export async function uninstallNativeHooks(deps: HostInstallDeps, spec: NativeHookConfig, removed: string[]): Promise<void> {
  const file = filePath(deps.home, spec);
  try {
    const result = await editJsonFile(file, document => {
      validate(document, spec);
      if (!document.hooks) return false;
      let changed = false;
      for (const event of spec.events) {
        const list = document.hooks[event.event];
        if (!Array.isArray(list)) continue;
        const kept = withoutManaged(list, spec, event);
        if (JSON.stringify(kept) === JSON.stringify(list)) continue;
        changed = true;
        if (kept.length > 0) document.hooks[event.event] = kept;
        else delete document.hooks[event.event];
      }
      if (changed && Object.keys(document.hooks).length === 0) delete document.hooks;
      return changed;
    });
    if (result.changed) removed.push(path.relative(deps.home, file));
  } catch {
    deps.log?.(`  kept ${file} (unreadable or incompatible configuration); no user hooks removed`);
  }
}

export async function doctorNativeHooks(deps: HostDoctorDeps, spec: NativeHookConfig): Promise<HostDoctorCheck[]> {
  const file = filePath(deps.home, spec);
  let current = false;
  let detail = "missing or invalid native hook configuration";
  try {
    const document: unknown = JSON.parse(await readFile(file, "utf8"));
    validate(document, spec);
    const expected = subscriptions({ ...deps, launcher: deps.config.launcher }, spec);
    const disabled = spec.kind === "gemini-cli" && (document.hooksConfig?.enabled === false || expected.some(({ event }) => {
      const actual = document.hooks?.[event.event] ?? [];
      const own = actual.flatMap((group: any) => Array.isArray(group?.hooks) ? group.hooks : [])
        .filter((hook: any) => managed(hook, spec, event));
      return Array.isArray(document.hooksConfig?.disabled) && own.some((hook: any) =>
        document.hooksConfig.disabled.includes(hook.name || hook.command));
    }));
    current = !disabled && expected.every(({ event, entry }) => {
      const actual = document.hooks?.[event.event];
      if (!Array.isArray(actual)) return false;
      const flat = spec.grouped ? actual.flatMap(group => Array.isArray(group?.hooks) ? group.hooks : []) : actual;
      const wanted: any = spec.grouped ? (entry as any).hooks[0] : entry;
      const own = flat.filter(hook => managed(hook, spec, event));
      return own.length === 1 && own[0].command === wanted.command && own[0].type === "command";
    });
    detail = disabled ? "hooks disabled by user configuration; preserved unchanged" : current
      ? `Native subscriptions present at ${file}; configuration alone does not prove host loading or execution.`
      : "missing, duplicate or stale native subscriptions; rerun 37soul install";
  } catch { /* Read-only diagnostics; never create or repair configuration. */ }
  const evidence = await readRuntimeEvidence(deps.home, spec.kind);
  return [
    { name: `${spec.kind}: native hook configuration`, ok: current, detail },
    { name: `${spec.kind}: trust/load`, ok: false, detail: "Host trust/load is not verified. A config write or hook-output receipt does not prove host trust or model adoption." },
    ...runtimeEvidenceChecks(spec.kind, evidence).map(check => check.name.endsWith(": extraction") && !check.ok
      ? { ...check, detail: `${check.detail} ${spec.extractionBlocker}` }
      : check),
  ];
}

/** Native hooks must never coerce objects or numbers into session identities. */
export function nativeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
