/**
 * Task 10: the four runtime adapters wired behind agentd's assets-mode drain, with a
 * spawn-based `NativeInvoker` as the only native model surface.
 *
 * Why the adapters were inert until now: `extractAdapters` in `createDaemon`
 * defaults to `{}`, and `runDrain` no-ops when it is empty, so no extraction ever
 * ran in production. This module builds the real adapter map and hands it to the
 * daemon from `startAgentd` — but only in assets mode (legacy mode has no extraction
 * watermarks and must keep its transcript-upload path unchanged).
 *
 * Honesty contract for `readSource`: the hook emits opaque random event refs
 * (`event_ref: randomUUID()`), and there is no local index that maps a ref back to a
 * raw transcript yet. `readSource` therefore returns "" rather than fabricating
 * source, and every adapter short-circuits to `{ proposals: [] }` before any model
 * call (see claude-code.ts / codex.ts / opencode.ts / hermes.ts `extract`). The
 * spawn invoker is fully wired but is only reached once a real source index exists.
 */
import { execFile } from "node:child_process";
import type { RuntimeKind } from "../assets/protocol.js";
import type { AdapterDeps, NativeInvoker, RuntimeAdapter } from "../adapters/types.js";
import { createClaudeCodeAdapter } from "../adapters/claude-code.js";
import { createCodexAdapter } from "../adapters/codex.js";
import { createOpenCodeAdapter } from "../adapters/opencode.js";
import { createHermesAdapter } from "../adapters/hermes.js";

/** Runtime kind -> native CLI binary name. The adapters invoke by runtime kind; this
 *  is the only place the concrete binary spelling lives. */
const RUNTIME_BINARIES: Record<RuntimeKind, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  hermes: "hermes",
};

export interface NativeInvokerLog {
  info(message: string): void;
  error(message: string): void;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => { stdin?: { write(chunk: string): void; end(): void } | null; kill(): void };

const defaultSpawn: SpawnFn = (command, args, options, callback) =>
  execFile(command, [...args], options, (error, stdout, stderr) => {
    callback(error, stdout ?? "", stderr ?? "");
  });

/**
 * Spawn the native CLI (never a shell) and pipe `input` to its stdin. The internal
 * job uid travels in `SOUL37_INTERNAL_JOB_UID` so the runtime-side hook can tag any
 * session it opens and the scheduler can exclude it from recursive extraction.
 * A fixed timeout bounds the wait; a killed process still resolves (code 124-style)
 * rather than hanging the drain. `spawn` is injectable for tests.
 */
export function createNativeInvoker(log?: NativeInvokerLog, spawn: SpawnFn = defaultSpawn): NativeInvoker {
  return (runtime, args, input, internal_job_uid) =>
    new Promise((resolve) => {
      const command = RUNTIME_BINARIES[runtime];
      const child = spawn(
        command,
        args,
        { timeout: 60_000, env: { ...process.env, SOUL37_INTERNAL_JOB_UID: internal_job_uid } },
        (error, stdout, stderr) => {
          let code = 0;
          if (error) {
            const maybeCode = (error as { code?: unknown }).code;
            code = typeof maybeCode === "number" ? maybeCode : 1;
            log?.error(`native ${runtime} exited ${code}: ${String((error as { message?: string }).message ?? error)}`);
          }
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
      if (child.stdin) {
        child.stdin.write(input);
        child.stdin.end();
      } else {
        log?.error(`native ${runtime} spawn produced no stdin pipe`);
        child.kill();
      }
    });
}

/**
 * Build the four real adapters on one shared `AdapterDeps`. `emit` is a no-op: none
 * of the four adapters call `deps.emit` during extract/inject (injection for
 * claude-code goes through the global hook; codex/opencode/hermes inject through
 * their own plugin/bridge and return `delivered:false` unverified).
 */
export function createExtractAdapters(home: string, log?: NativeInvokerLog): Partial<Record<RuntimeKind, RuntimeAdapter>> {
  const invoke = createNativeInvoker(log);
  const readSource = async () => "";
  const emit = async () => {};
  const deps: AdapterDeps = { home, invoke, readSource, emit };
  return {
    "claude-code": createClaudeCodeAdapter(deps),
    codex: createCodexAdapter(deps),
    opencode: createOpenCodeAdapter(deps),
    hermes: createHermesAdapter(deps),
  };
}
