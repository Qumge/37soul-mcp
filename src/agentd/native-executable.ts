/** Deterministic native execution paths: stable user launchers, then explicit PATH. */
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { HostInvokeSpec } from "../hosts/types.js";

export function buildExecutionPath(home: string, nodePath: string, existingPath = ""): string {
  const entries = [path.dirname(nodePath), ...[".local/bin", ".opencode/bin", ".hermes/venv/bin", ".npm-global/bin"].map(dir => path.join(home, dir)), ...existingPath.split(path.delimiter), "/usr/bin", "/bin"];
  // Empty/relative entries would make the daemon search its working directory.
  return [...new Set(entries.filter(entry => path.isAbsolute(entry)))].join(path.delimiter);
}

export async function resolveNativeExecutable(spec: HostInvokeSpec, home: string, executionPath: string): Promise<string | null> {
  const candidates = [...spec.userLaunchers.map(file => path.join(home, file)), ...executionPath.split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, spec.binary))];
  for (const file of new Set(candidates)) {
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch { /* Missing, broken or non-executable candidate is not a launcher. */ }
  }
  return null;
}
