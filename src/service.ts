/**
 * 后台服务：macOS LaunchAgent / Linux systemd user unit（设计 §6.1）。
 *
 * 只做两件事：写我们自己的服务文件（绝对路径、argv 传参、XML/空格转义），
 * 调用系统的 load/enable 命令。卸载时只删我们写的那一个文件 —— 用户目录里
 * 别的 LaunchAgent/unit 一根汗毛都不碰。
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const SERVICE_LABEL = "com.37soul.agentd";

export interface ServiceSpec {
  home: string;
  nodePath: string;
  scriptPath: string;
  logPath: string;
  platform?: NodeJS.Platform;
}

export type RunCommand = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

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
  const args = [spec.nodePath, spec.scriptPath, "agentd"]
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
ExecStart=${[spec.nodePath, spec.scriptPath, "agentd"].map(quote).join(" ")}
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
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, renderPlist(spec), { mode: 0o644 });
    commands.push(["launchctl", "load", "-w", file]);
    const result = await run(commands[commands.length - 1]);
    if (result.code !== 0) {
      // 失败回滚：别留下一个加载不起来的服务文件。
      await rm(file, { force: true });
      throw new Error(`launchctl load failed: ${result.stderr || result.stdout}`);
    }
    return { serviceFile: file, commands };
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
