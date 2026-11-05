import {finalNativeRecord,normalizeClaudeExtraction} from '../extraction/native-output.js';
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
 * A per-runtime timeout bounds the wait; a killed process still resolves (code
 * 124-style) rather than hanging the drain. `spawn` is injectable for tests.
 */
export interface NativeExecutionOptions {
  home?: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  /** OS-level proxy settings for children that did not inherit the user's shell. */
  systemProxy?: () => Promise<NodeJS.ProcessEnv>;
}

/**
 * Codex can spend a long time on a cold model start, and a slow-route turn was
 * measured at 115s; everything else keeps the 60s bound.
 */
const NATIVE_TIMEOUT_MS: Partial<Record<RuntimeKind, number>> = { codex: 180_000 };
const NATIVE_TIMEOUT_DEFAULT_MS = 60_000;

/** One read-only system query, injectable so proxy parsing stays testable. */
type SystemCommand = (command: string, args: readonly string[]) => Promise<{ stdout: string }>;

const runSystemCommand: SystemCommand = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { timeout: 2_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve({ stdout: stdout ?? "" });
  });
});

/**
 * macOS keeps the user's proxy in SystemConfiguration, not in the process
 * environment. A launchd agent never sees the shell's HTTP(S)_PROXY exports, so
 * a native CLI it spawns falls back to a direct connection — on a proxied route
 * that turned one extraction into a 115s turn, past the previous 120s bound.
 * Only darwin has a supported system reader; elsewhere this is an honest no-op.
 */
export function systemProxyEnvironment(output: string): NodeJS.ProcessEnv {
  const field = (key: string) => output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m"))?.[1];
  const url = (scheme: string, hostKey: string, portKey: string) => {
    const host = field(hostKey);
    const port = field(portKey);
    return host && port ? `${scheme}://${host}:${port}` : undefined;
  };
  const env: NodeJS.ProcessEnv = {};
  const add = (name: string, value: string | undefined) => { if (value) env[name] = value; };
  if (field("HTTPEnable") === "1") add("HTTP_PROXY", url("http", "HTTPProxy", "HTTPPort"));
  if (field("HTTPSEnable") === "1") add("HTTPS_PROXY", url("http", "HTTPSProxy", "HTTPSPort"));
  if (field("SOCKSEnable") === "1") add("ALL_PROXY", url("socks5", "SOCKSProxy", "SOCKSPort"));
  const block = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  const exceptions = block
    .split("\n")
    .map(line => line.replace(/^\s*\d+\s*:\s*/, "").trim())
    .filter(entry => entry !== "" && entry !== "<local>")
    // NoProxy matches by suffix; `*.local` already means every *.local host.
    .map(entry => (entry.startsWith("*.") ? entry.slice(1) : entry));
  if (exceptions.length > 0) env.NO_PROXY = exceptions.join(",");
  return env;
}

export async function readSystemProxyEnv(
  platform: NodeJS.Platform = process.platform,
  run: SystemCommand = runSystemCommand,
): Promise<NodeJS.ProcessEnv> {
  if (platform !== "darwin") return {};
  try {
    return systemProxyEnvironment((await run("/usr/sbin/scutil", ["--proxy"])).stdout);
  } catch {
    return {};
  }
}

/**
 * Fixed classification allowlist for child stderr. Only the class name and byte
 * count reach the log: raw stderr can embed prompts, arguments or provider
 * credentials, so it is never interpolated.
 */
const STDERR_CLASSES: ReadonlyArray<readonly [string, RegExp]> = [
  ["rate_limited", /rate.?limit|too many requests|\b429\b/i],
  ["quota", /quota|usage limit|insufficient_quota|billing/i],
  ["auth", /unauthori[sz]ed|forbidden|\b401\b|\b403\b|invalid api key|not logged in|login required|please (?:run |log ?in)/i],
  ["network", /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|getaddrinfo/i],
  ["usage", /unexpected argument|unknown (?:option|argument)|invalid (?:value|argument)|usage:/i],
];

function classifyNativeStderr(stderr: string): string {
  for (const [name, pattern] of STDERR_CLASSES) if (pattern.test(stderr)) return name;
  return "other";
}

function failureDetail(error: unknown, stderr: string, timeoutMs: number): string {
  const killed = (error as { killed?: unknown } | null)?.killed;
  if (killed === true) return ` (timeout after ${timeoutMs}ms)`;
  if (stderr === "") return "";
  return ` (stderr ${classifyNativeStderr(stderr)}, ${Buffer.byteLength(stderr, "utf8")} bytes)`;
}

export function createNativeInvoker(log?: NativeInvokerLog, spawn: SpawnFn = defaultSpawn, options?: NativeExecutionOptions): NativeInvoker {
  // Existing injected spawns are virtual commands. Explicit options opt them into
  // real path resolution; production always resolves before executing.
  const resolvePaths = spawn === defaultSpawn || options !== undefined;
  const home = options?.home ?? os.homedir();
  const inherited = options?.env ?? process.env;
  const executionPath = buildExecutionPath(home, options?.nodePath ?? process.execPath, inherited.PATH);
  const env = { ...inherited, PATH: executionPath };
  // Virtual spawns in tests stay hermetic; a real execution reads the OS setting.
  const systemProxy = options?.systemProxy ?? (resolvePaths ? () => readSystemProxyEnv() : async () => ({}));
  return async (runtime, args, input, internal_job_uid) => {
    const spec = HOSTS.find(host => host.kind === runtime)?.invoke;
    if (!spec) {
      return { code: 1, stdout: "", stderr: `no native binary registered for ${runtime}` };
    }
    const command = resolvePaths ? await resolveNativeExecutable(spec, home, executionPath) : spec.binary;
    if (!command) return { code: 1, stdout: "", stderr: `native ${runtime} executable unavailable; install the current host CLI` };
    const timeoutMs = NATIVE_TIMEOUT_MS[runtime] ?? NATIVE_TIMEOUT_DEFAULT_MS;
    const run = async (argv: readonly string[], stdin: string) => {
      // The system proxy fills gaps only: a proxy the environment already names wins.
      const proxyEnv = await systemProxy();
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(command, argv,
        { timeout: timeoutMs, env: { ...proxyEnv, ...env, ...(runtime === "claude-code" ? {CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1024", CLAUDE_CODE_DISABLE_THINKING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"} : {}), SOUL37_INTERNAL_JOB_UID: internal_job_uid } },
        (error, stdout, stderr) => {
          const exitCode = (error as { code?: unknown } | null)?.code;
          const code = error ? (typeof exitCode === "number" ? exitCode : 1) : 0;
          // Provider-reported tokens are distinct from our reservations and unknown CLI dollar estimates.
          try {
            const report=finalNativeRecord(stdout);let input=0,output=0,cache=0,seen=false;
            const n=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:0;
            if(report?.modelUsage&&typeof report.modelUsage==="object"){
              for(const value of Object.values(report.modelUsage) as Record<string,unknown>[]){if(!value||typeof value!=="object")continue;input+=n(value.inputTokens);output+=n(value.outputTokens);cache+=n(value.cacheReadInputTokens);seen=true;}
            }else if(report?.usage&&typeof report.usage==="object"){input=n(report.usage.input_tokens);output=n(report.usage.output_tokens);cache=n(report.usage.cache_read_input_tokens);seen=true;}
            if(seen)log?.info(`native ${runtime} reported tokens: input ${input}, output ${output}, cache_read ${cache}`);
          }catch{/* Missing usage is unknown, never a fabricated zero-cost result. */}
          // execFile errors can embed stderr, arguments or provider credentials.
          const result=runtime==="claude-code"?normalizeClaudeExtraction(code,stdout??"",argv):{code,stdout:stdout??""};
          if(result.code!==0)log?.error(`native ${runtime} exited ${result.code}${failureDetail(error, stderr ?? "", timeoutMs)}`);
          else if(code!==0)log?.info(`native ${runtime} reused complete JSON at the one-turn boundary`);
          resolve({ ...result, stderr: stderr ?? "" });
        });
      if (child.stdin) { child.stdin.write(stdin); child.stdin.end(); }
      else { log?.error(`native ${runtime} spawn produced no stdin pipe`); child.kill(); }
      });
    };
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
