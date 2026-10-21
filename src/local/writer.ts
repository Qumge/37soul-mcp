/**
 * Task 2: the single writer process + local IPC envelope.
 *
 * `startWriter(root)` acquires the exclusive writer lock (one writer process),
 * then serves newline-delimited JSON over a Unix socket in a 0700 directory with
 * a 0600 socket. Requests are capped at 1 MiB and validated against the command
 * whitelist. Commands are dispatched through a registry, one at a time (serialized
 * commits); Tasks 3–5 register their own commands, and an unregistered command
 * returns a well-defined `unsupported_command` error instead of crashing.
 *
 * This is NOT an external HTTP service: it only accepts the local user, and the
 * hook merely delivers local events through it — the hook never writes the
 * snapshot directly. IPC unavailability never fails a working session (sendWriter
 * always resolves to a WriterResult).
 */
import net from "node:net";
import { chmod, readdir } from "node:fs/promises";
import { ValidationError } from "../assets/validation.js";
import {
  acquireWriterLock,
  defaultStoreFs,
  ipcDir,
  ipcSocketPath,
  openStore,
  profilesDir,
  StoreError,
  type ProfileId,
  type StoreFs,
} from "./store.js";

export const MAX_FRAME_BYTES = 1024 * 1024;

export const WRITER_COMMANDS = [
  "create_soul",
  "authorize_soul",
  "edit_local_identity",
  "set_soul_avatar",
  "bind",
  "detach",
  "review_asset",
  "delete_asset",
  "runtime_event",
  "begin_extraction",
  "commit_extraction",
  "fail_extraction",
  "sync_once",
  "record_receipt",
  "status",
  "export",
  "login_associate",
  "init_assets_profile",
] as const;

export type WriterCommand = (typeof WRITER_COMMANDS)[number];

export interface WriterRequest {
  request_uid: string;
  profile_id: ProfileId;
  command: WriterCommand;
  payload: Record<string, unknown>;
}

export type WriterResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface WriterCommandContext {
  root: string;
  request: WriterRequest;
}

export type WriterCommandHandler = (ctx: WriterCommandContext) => Promise<unknown>;

const commandRegistry = new Map<string, WriterCommandHandler>();

/** Tasks 3–5 register their own commands. An unregistered command is refused, not a no-op. */
export function registerWriterCommand(command: string, handler: WriterCommandHandler): void {
  commandRegistry.set(command, handler);
}

// --- the only command Task 2 ships -----------------------------------------------

registerWriterCommand("status", async ({ root }) => {
  const ids = await listProfiles(root);
  const profiles: unknown[] = [];
  for (const profileId of ids) {
    let state = "ok";
    let message: string | undefined;
    try {
      const store = await openStore(root, profileId);
      try {
        await store.read();
      } finally {
        await store.close();
      }
    } catch (error) {
      state = error instanceof StoreError && error.code === "repair_required" ? "repair_required" : "error";
      message = error instanceof Error ? error.message : String(error);
    }
    profiles.push({ profile_id: profileId, state, ...(message ? { message } : {}) });
  }
  return { store_version: 1, writer_pid: process.pid, profiles };
});

async function listProfiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(profilesDir(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function dispatch(root: string, request: WriterRequest): Promise<WriterResult> {
  const handler = commandRegistry.get(request.command);
  if (!handler) {
    return Promise.resolve({
      ok: false,
      error: { code: "unsupported_command", message: `command not registered: ${request.command}` },
    });
  }
  return handler({ root, request }).then(
    (result) => ({ ok: true, result: result ?? null }) as WriterResult,
    (error: unknown) => ({ ok: false, error: { code: errorCode(error), message: errorMessage(error) } }) as WriterResult,
  );
}

function errorCode(error: unknown): string {
  if (error instanceof StoreError) return error.code;
  if (error instanceof ValidationError) return "validation_error";
  return "internal_error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function parseRequest(line: string): WriterRequest | null {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.request_uid !== "string" || record.request_uid.length === 0) return null;
  if (typeof record.profile_id !== "string" || record.profile_id.length === 0) return null;
  if (typeof record.command !== "string" || !(WRITER_COMMANDS as readonly string[]).includes(record.command)) {
    return null;
  }
  if (record.payload === undefined) record.payload = {};
  if (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) return null;
  return {
    request_uid: record.request_uid,
    profile_id: record.profile_id,
    command: record.command as WriterCommand,
    payload: record.payload as Record<string, unknown>,
  };
}

export interface StartWriterOptions {
  fs?: Partial<StoreFs>;
}

export async function startWriter(
  root: string,
  options: StartWriterOptions = {},
): Promise<{ close(): Promise<void> }> {
  const fs: StoreFs = { ...defaultStoreFs, ...(options.fs ?? {}) };
  const releaseLock = await acquireWriterLock(root, fs);

  const dir = ipcDir(root);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const sockPath = ipcSocketPath(root);
  await fs.rm(sockPath, { force: true }).catch(() => {});

  // Serialize command dispatch so commits are one-at-a-time.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES + 64) {
        socket.write(
          `${JSON.stringify({ ok: false, error: { code: "request_too_large", message: "request frame exceeds 1 MiB" } })}\n`,
        );
        socket.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const request = parseRequest(line);
        const pending = request === null
          ? Promise.resolve<WriterResult>({ ok: false, error: { code: "invalid_request", message: "malformed writer request frame" } })
          : enqueue(() => dispatch(root, request));
        pending
          .then((result) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify(result)}\n`);
          })
          .catch(() => {
            if (!socket.destroyed) socket.destroy();
          });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve());
  }).catch((error: unknown) => releaseLock().then(() => {
      throw error;
    }));
  await chmod(sockPath, 0o600).catch(() => {});

  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(sockPath, { force: true }).catch(() => {});
      await releaseLock();
    },
  };
}

export function sendWriter(root: string, request: WriterRequest): Promise<WriterResult> {
  const frame = JSON.stringify(request);
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
    return Promise.resolve({
      ok: false,
      error: { code: "request_too_large", message: "request frame exceeds 1 MiB" },
    });
  }
  return new Promise<WriterResult>((resolve) => {
    let settled = false;
    const finish = (result: WriterResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const socket = net.connect(ipcSocketPath(root), () => {
      socket.write(`${frame}\n`);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES + 64) {
        socket.destroy();
        finish({ ok: false, error: { code: "invalid_response", message: "writer response exceeds 1 MiB" } });
        return;
      }
      const idx = buffer.indexOf("\n");
      if (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        socket.destroy();
        try {
          const parsed: unknown = JSON.parse(line);
          finish(
            isWriterResult(parsed)
              ? parsed
              : { ok: false, error: { code: "invalid_response", message: "writer returned an invalid response" } },
          );
        } catch {
          finish({ ok: false, error: { code: "invalid_response", message: "writer returned an invalid response" } });
        }
      }
    });
    socket.on("error", () =>
      finish({ ok: false, error: { code: "writer_unavailable", message: "no writer is running — start agentd first" } }),
    );
    socket.on("close", () =>
      finish({ ok: false, error: { code: "writer_unavailable", message: "writer closed the connection" } }),
    );
  });
}

function isWriterResult(value: unknown): value is WriterResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return true;
  if (record.ok === false) {
    const error = record.error;
    return (
      error !== null &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).code === "string" &&
      typeof (error as Record<string, unknown>).message === "string"
    );
  }
  return false;
}
