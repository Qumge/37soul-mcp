/**
 * 后台服务：macOS LaunchAgent / Linux systemd user unit（设计 §6.1）。
 *
 * 只做两件事：写我们自己的服务文件（绝对路径、argv 传参、XML/空格转义），
 * 调用系统的 load/enable 命令。卸载时只删我们写的那一个文件 —— 用户目录里
 * 别的 LaunchAgent/unit 一根汗毛都不碰。
 */

import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const SERVICE_LABEL = "com.37soul.agentd";

export interface ServiceSpec {
  home: string;
  nodePath: string;
  scriptPath: string;
  logPath: string;
  platform?: NodeJS.Platform;
  uid?: number;
  /** 固定 runtime 的启动器：优先用它当命令（运行期解析 node）。 */
  launcherPath?: string;
}

export type RunCommand = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

function serviceArgs(spec: ServiceSpec): string[] {
  return spec.launcherPath ? [spec.launcherPath, "agentd"] : [spec.nodePath, spec.scriptPath, "agentd"];
}

export function plistPath(home: string): string {
  return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function systemdPath(home: string): string {
  return path.join(home, ".config", "systemd", "user", "37soul-agentd.service");
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderPlist(spec: ServiceSpec): string {
  const args = serviceArgs(spec)
    .map((argument) => `        <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(SERVICE_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(spec.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(spec.logPath)}</string>
  </dict>
</plist>
`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  // systemd 的引用规则：ExecStart 按 shell 风格分词，带空格/引号的参数要用双引号包住。
  const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`;
  return `[Unit]
Description=37Soul local agent capture (agentd)
After=network-online.target

[Service]
ExecStart=${serviceArgs(spec).map(quote).join(" ")}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface ServiceInstallResult {
  serviceFile: string;
  commands: string[][];
}

export async function installService(spec: ServiceSpec, run: RunCommand): Promise<ServiceInstallResult> {
  const platform = spec.platform ?? process.platform;
  const commands: string[][] = [];

  if (platform === "darwin") {
    const file = plistPath(spec.home);
    const uid = spec.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("cannot determine the launchd GUI user");
    const domain = `gui/${uid}`;
    const target = `${domain}/${SERVICE_LABEL}`;
    const inspect = ["launchctl", "print", target];
    commands.push(inspect);
    const current = await run(inspect);
    if (current.code === 0) {
      // Labels are per UID, not per HOME. An isolated test/install must never
      // evict the user's real service just because it uses the same label.
      const program = current.stdout.match(/^\s*program\s*=\s*(.+)$/m)?.[1];
      const args = current.stdout.match(/\barguments\s*=\s*\{([^}]+)\}/)?.[1] ?? "";
      const commandPaths = [program, ...args.split("\n")].filter((value): value is string => typeof value === "string")
        .map(value => value.trim().replace(/^\d+\s*=\s*/, "").replace(/^"(.*)"$/, "$1"));
      const homes = [spec.home, await realpath(spec.home).catch(() => spec.home)];
      const ownsCommand = commandPaths.some(command => path.isAbsolute(command) && homes.some(home => path.resolve(command).startsWith(path.join(home, ".37soul") + path.sep)));
      if (!ownsCommand) {
        throw new Error(`${SERVICE_LABEL} is already registered for a different HOME or its owner cannot be verified; keep that service and use agentd manually in this HOME`);
      }
    }
    // Stage atomically before stopping a healthy old daemon. Both nonzero and
    // thrown bootstrap failures restore its old plist and reload the old job.
    let previous: string | undefined;
    try { previous = await readFile(file, "utf8"); } catch {}
    if (current.code === 0 && previous === undefined) throw new Error("cannot safely upgrade a loaded service without its previous plist; keep the running job and restore its configuration first");
    let stopped = false;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writePlist(file, renderPlist(spec));
      if (current.code === 0) {
        const stop = ["launchctl", "bootout", target];
        commands.push(stop);
        const result = await run(stop);
        if (result.code !== 0) throw new Error(`launchctl bootout failed: ${result.stderr || result.stdout}`);
        stopped = true;
      }
      const start = ["launchctl", "bootstrap", domain, file];
      commands.push(start);
      const result = await run(start);
      if (result.code !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr || result.stdout}`);
      return { serviceFile: file, commands };
    } catch (error) {
      let recovery = "";
      try {
        if (previous === undefined) await rm(file, { force: true });
        else await writePlist(file, previous);
        if (stopped && previous !== undefined) {
          const rollback = ["launchctl", "bootstrap", domain, file];
          commands.push(rollback);
          const restored = await run(rollback);
          if (restored.code !== 0) recovery = `; previous service restore failed: ${restored.stderr || restored.stdout}`;
        }
      } catch (restoreError) { recovery = `; previous service restore failed: ${(restoreError as Error).message}`; }
      throw new Error(`${error instanceof Error ? error.message : String(error)}${recovery}`);
    }
  }

  if (platform === "linux") {
    const file = systemdPath(spec.home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, renderSystemdUnit(spec), { mode: 0o644 });
    commands.push(["systemctl", "--user", "daemon-reload"]);
    commands.push(["systemctl", "--user", "enable", "--now", "37soul-agentd.service"]);
    for (const command of commands) {
      const result = await run(command);
      if (result.code !== 0) {
        await rm(file, { force: true });
        throw new Error(`${command[0]} failed: ${result.stderr || result.stdout}`);
      }
    }
    return { serviceFile: file, commands };
  }

  throw new Error(`unsupported platform for the background service: ${platform}`);
}

export async function removeService(spec: ServiceSpec, run: RunCommand): Promise<void> {
  const platform = spec.platform ?? process.platform;
  if (platform === "darwin") {
    const file = plistPath(spec.home);
    await run(["launchctl", "unload", "-w", file]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    await rm(file, { force: true });
    return;
  }
  if (platform === "linux") {
    await run(["systemctl", "--user", "disable", "--now", "37soul-agentd.service"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    await rm(systemdPath(spec.home), { force: true });
    await run(["systemctl", "--user", "daemon-reload"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    return;
  }
  // 其他平台没有服务可删。
  await chmod(path.join(spec.home, ".37soul"), 0o700).catch(() => {});
}

async function writePlist(file: string, contents: string): Promise<void> {
  const staged = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(staged, contents, { mode: 0o644 });
    await rename(staged, file);
  } finally { await rm(staged, { force: true }); }
}
