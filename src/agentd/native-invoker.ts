import {withBatchExtraction} from '../extraction/batch-adapter.js';
export {withBatchExtraction} from '../extraction/batch-adapter.js';
/**
 * Task 10: the runtime adapters wired behind agentd's assets-mode drain, with a
 * spawn-based `NativeInvoker` as the only native model surface.
 *
 * Why the adapters were inert until now: `extractAdapters` in `createDaemon`
 * defaults to `{}`, and `runDrain` no-ops when it is empty, so no extraction ever
 * ran in production. This module builds the real adapter map and hands it to the
 * daemon from `startAgentd` — but only in assets mode (legacy mode has no extraction
 * watermarks and must keep its transcript-upload path unchanged).
 *
 * Honesty contract for `readSource` (Task 10c): the hook emits opaque random event
 * refs (`event_ref: randomUUID()`); `readSource` resolves them through the local
 * path-pointer index (`source-index.ts`), reads at most one bounded file prefix, and
 * returns "" when no pointer exists — it never fabricates source. Every adapter
 * short-circuits to `{ proposals: [] }` before any model call when the resolved
 * source is empty (see claude-code.ts / codex.ts / opencode.ts / hermes.ts
 * `extract`). The spawn invoker is reached only once a pointer resolves.
 */
import { formatExtractionDiagnostic } from "../extraction/diagnostics.js";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { buildExecutionPath, resolveNativeExecutable } from "./native-executable.js";
import type { RuntimeKind } from "../assets/protocol.js";
import type { AdapterDeps, NativeInvoker, RuntimeAdapter } from "../adapters/types.js";
import { HOSTS } from "../hosts/registry.js";
import { readSourceRefs } from "./source-index.js";

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
export interface NativeExecutionOptions {
  home?: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
}

export function createNativeInvoker(log?: NativeInvokerLog, spawn: SpawnFn = defaultSpawn, options?: NativeExecutionOptions): NativeInvoker {
  // Existing injected spawns are virtual commands. Explicit options opt them into
  // real path resolution; production always resolves before executing.
  const resolvePaths = spawn === defaultSpawn || options !== undefined;
  const home = options?.home ?? os.homedir();
  const inherited = options?.env ?? process.env;
  const executionPath = buildExecutionPath(home, options?.nodePath ?? process.execPath, inherited.PATH);
  const env = { ...inherited, PATH: executionPath };
  return async (runtime, args, input, internal_job_uid) => {
    const spec = HOSTS.find(host => host.kind === runtime)?.invoke;
    if (!spec) {
      return { code: 1, stdout: "", stderr: `no native binary registered for ${runtime}` };
    }
    const command = resolvePaths ? await resolveNativeExecutable(spec, home, executionPath) : spec.binary;
    if (!command) return { code: 1, stdout: "", stderr: `native ${runtime} executable unavailable; install the current host CLI` };
    const run = (argv: readonly string[], stdin: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(command, argv,
        { timeout: 60_000, env: { ...env, ...(runtime === "claude-code" ? {CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1024", CLAUDE_CODE_DISABLE_THINKING: "1"} : {}), SOUL37_INTERNAL_JOB_UID: internal_job_uid } },
        (error, stdout, stderr) => {
          const exitCode = (error as { code?: unknown } | null)?.code;
          const code = error ? (typeof exitCode === "number" ? exitCode : 1) : 0;
          // Provider-reported tokens are distinct from our reservations and unknown CLI dollar estimates.
          try {
            const report=JSON.parse(stdout);let input=0,output=0,cache=0,seen=false;
            const n=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:0;
            if(report.modelUsage&&typeof report.modelUsage==="object"){
              for(const value of Object.values(report.modelUsage) as Record<string,unknown>[]){if(!value||typeof value!=="object")continue;input+=n(value.inputTokens);output+=n(value.outputTokens);cache+=n(value.cacheReadInputTokens);seen=true;}
            }else if(report.usage&&typeof report.usage==="object"){input=n(report.usage.input_tokens);output=n(report.usage.output_tokens);cache=n(report.usage.cache_read_input_tokens);seen=true;}
            if(seen)log?.info(`native ${runtime} reported tokens: input ${input}, output ${output}, cache_read ${cache}`);
          }catch{/* Missing usage is unknown, never a fabricated zero-cost result. */}
          // execFile errors can embed stderr, arguments or provider credentials.
          if (error) log?.error(`native ${runtime} exited ${code}`);
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        });
      if (child.stdin) { child.stdin.write(stdin); child.stdin.end(); }
      else { log?.error(`native ${runtime} spawn produced no stdin pipe`); child.kill(); }
    });
    if (resolvePaths && spec.requiredMajor !== undefined) {
      const version = await run(["--version"], "");
      const major = version.stdout.trim().match(/^(?:opencode\s+)?v?(\d+)\./i)?.[1];
      if (version.code !== 0 || Number(major) !== spec.requiredMajor) {
        return { code: 1, stdout: "", stderr: `native ${runtime} requires CLI generation ${spec.requiredMajor}; version check failed (no extraction attempted)` };
      }
    }
    // Never retry a failed canonical launcher via another PATH installation.
    return run(args, input);
  };
}

/**
 * Build the real adapters on one shared `AdapterDeps`. `readSource` resolves
 * the opaque event refs through the local path-pointer index (Task 10c) and reads
 * at most one bounded file — it never fabricates source and returns "" when no
 * pointer exists. `emit` is a no-op: none of the adapters call `deps.emit`
 * during extract/inject (injection for claude-code goes through the global hook;
 * codex/opencode/hermes inject through their own plugin/bridge and return
 * `delivered:false` unverified).
 */
export function createExtractAdapters(home: string, log?: NativeInvokerLog, root = path.join(home, ".37soul")): Partial<Record<RuntimeKind, RuntimeAdapter>> {
  const invoke = createNativeInvoker(log, undefined, { home });
  const readSource = async (refs: readonly string[], turnRefs?: readonly string[]) => readSourceRefs(root, refs, turnRefs);
  const emit = async () => {};
  const deps: AdapterDeps = { home, invoke, readSource, emit, diagnostic: counts => log?.info(formatExtractionDiagnostic(counts)) };
  return Object.fromEntries(
    HOSTS.flatMap((host) => host.invoke ? [[host.kind, withBatchExtraction(host.invoke.createAdapter, deps)]] : []),
  );
}
