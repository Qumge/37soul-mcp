export function hookCommand(deps: { nodePath: string; cliScriptPath: string; launcher?: string }, agentKind: string, event = "SessionStart"): string {
  // 有固定 runtime 时指向启动器（运行期解析 node）；否则退回安装时的绝对路径。
  if (deps.launcher) return `"${deps.launcher}" hook --agent ${agentKind} --event ${event}`;
  return `"${deps.nodePath}" "${deps.cliScriptPath}" hook --agent ${agentKind} --event ${event}`;
}
