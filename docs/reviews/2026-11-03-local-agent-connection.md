# 本机 Agent 接入修复验收 — 0.15.0 account-first 候选版

状态：本轮 runtime 源码、测试和文档已审查，完整本地验收通过；发布继续暂停。未 push、未合并、未创建 tag/Release、未部署网站、未替换本机安装。本报告不证明公开 curl 已能安装本次实现。

## 当前主流程

1. 用户运行 `37soul login`，在浏览器核对短码并批准这台设备。此步骤只完成账号登录；不要求挑选 Soul，也不自动下载全部角色。终端提示账号就绪并引导在 Agent 中选择。`login --host ID` 仅保留旧的显式定向授权兼容路径，不再作为角色选择的主入口。
2. 本地 Agent 用现有账号凭据执行 `37soul hosts`，可按名称过滤、分页查看自有 Soul 目录。目录读取不授权、绑定、创建或下载角色，不向 Agent 输出凭据。
3. 用户说“连接 Sophia Ramirez”后，Agent 使用 `37soul connect --name "Sophia Ramirez" --agent KIND --session NATIVE_ID`。名称必须唯一；重名时要求明确 Host ID，未知名称不擅自创建替代角色。也支持 `connect --host ID`。原生会话参数必须来自当前 hook，不能按终端最近活动猜测。
4. 首次选择通过当前账号/设备凭据确认该自有角色和 consent，再恢复这一 Soul；只有 identity 校验和精确原生会话绑定完成后才输出 `connection.state: attached`。更换另一个已有 Soul 复用同一份账号登录，不开启第二次远程 OAuth。`whoami` 在选择后只读身份，不隐式选择或授权。
5. 已明确撤销的 identity consent 必须由用户显式重新启用；已缩小的权限范围保留。网络中断后的恢复重试保留 pull checkpoint，不反复重置下载进度，也不要求重新登录。

## 数据与会话边界

- 目录、角色选择和身份读取按服务器、账号、设备、profile、runtime 选择已有凭据；请求前后复核账号/设备与 consent。响应或异常正文中的凭据不进入对外错误。relationship/experience 关闭时，不输出其衍生内容。
- 角色选择通过本地 writer 命令执行；仅在 composition root 注入 HTTP 传输。选择完成前后的活动 profile/设备变化会拒绝本次连接，避免误报 attached。
- `connect_session` 切换生成新的不透明云端 `session_ref`，本地字节边界、文件身份和摘要指纹隔离旧来源。被替换的绑定保留在非 canonical 字典键下，带仅本地使用的 retired 标记；原云端 state/revision 和冻结 outbox 不被重写。
- 旧绑定尚未同步的控制操作和已完成旧资产仍可按原 UID/Soul/provenance 发送，ACK 可定位归档元数据。原生解析、注入、当前绑定断言、提取 claim/drain 只认 canonical 当前绑定；旧待办任务不调用模型，切换前已启动任务的旧结果也不能提交。未把旧资产或来源改挂到新 Soul。
- 撤销私有身份后，hook 仅可提供非私密的原生会话恢复参数；暂停时完全静默。压缩/替换来源后可显式重新接入。
- 设备 PAT 的 HTTP 身份读取按实时同意受控；设备 PAT 经远程 MCP whoami 绕行仍被拒绝。无设备的远程 PAT/OAuth 行为保留。未知来源或不同账号的旧 profile 未自动合并、未删除；共享 skill 安装副本未改动。

## 新增宿主的实际范围

Gemini CLI、Cursor 是部分接入：原生 hook 配置、事件解析、身份上下文、本地 source pointer/完成 ID、受管卸载和保守诊断。现有五个宿主保留。
两者暂未启用自动记忆提炼，不应称为完整本地记忆增长。空来源保持 `source_unavailable` 契约；非空来源返回明确工具安全 blocker，不调用其他 CLI 或云端模型兜底。Gemini 临时 `--policy` 可被 Admin 策略覆盖，系统 settings override 不隔离系统 policies；Cursor 未建立可完全禁用工具/MCP 的原生调用。配置存在不证明 trust/load、模型采用或提炼成功。官方证据见 [新增宿主边界](../new-native-hosts.md)。

## 本次 runtime 最终验证

本轮只运行 Node/runtime 验证，没有运行 Rails。

| 检查 | 最终结果 |
| --- | --- |
| `npm test` 内的 TypeScript build | 通过 |
| `npm test` 内的 bundle build | 通过 |
| 完整 `node --test ./test/*.test.mjs` | **717 tests / 716 pass / 0 fail / 1 skip**；cancelled 0，todo 0 |
| `node test/smoke.mjs` | **64 checks 全部通过**，与上行测试数分别计数 |
| 当前待提交源码/测试及中英文 README 审查 | 保留全部预期改动；未做无关清理 |
| `git diff --check` | 通过 |

- 环境：Node **v24.18.0**。唯一 skip 是本机没有 Node 18 二进制；不能把本机通过等同于 Node 18/20 或 CI 已通过。
- 完整 suite 包含 account-first 11 项、原本机连接 24 项、独立 bundle 2 项、归档绑定 7 项；这些已包含在 717 内，不另行累加。独立 bundle 子进程在无 node_modules 的目录使用合成 HTTP 服务和真实本地 writer IPC，验证账号目录与首次角色接入，不接触生产账号。
- 归档绑定首次 red 为 6 项中 1 pass/5 fail；consent 提示补测先 red，最终 7/7。Gemini 禁用状态与 doctor 的 `name || command` 复核修复已在 `08351cc`；重命名/未命名禁用 hook 在启动器升级后保持禁用。
- 中断恢复 checkpoint 回归已修复并在本次完整 suite 通过；先前该用例 `resume-42` 被重置为 `0` 的失败已被最终结果替代。
- 现有 tarball 的 manifest/digest/VERSION/目录一致性测试本次执行且未跳过；该测试不比较包内代码与本轮源码，不能据此把旧 tarball 当成本轮 account-first 交付物。

## 跨仓库证据与未重新验证项

- Website：父任务提供最终提交 **`c8da9bfe`**，定向 **382 examples / 0 failures**。本轮未重跑 Rails；此前 341 examples 的结果是旧快照，不再作为最终数量。
- 旧定向登录流程的 12 个渲染检查及“host 277 / required=true”表单检查属于上一版流程，不能替代 account-only 登录与 Agent 内角色选择的最新 UI 验收。独立 HTML 由父任务处理，本轮未创建或验收该产物。
- Skill：此前提交 `3d920c8ab5fd7625ddc5f290b315f5fd3ff9715f`、版本 6.12.3 的 10 个契约测试/验证器属于既有证据；本轮未重跑，未修改安装副本，不据此宣称 account-first 文案已完成跨仓库验收。

## 提交与候选产物

- Runtime 原生宿主：`48fd3144b00e5acbe52c97d52dd99dfc2de3d043`。
- Runtime 原核心修复：`6a47a77`；Gemini 禁用状态：`08351cc72339aec49747645ecf2b1bc1fc5e8f65`；归档绑定与当前任务边界：`4519044`。
- Runtime account-first 实现、中英文说明及本报告由本报告所在提交一并保存；本轮没有修改包版本、打 tag 或发布。
- Website 最终：`c8da9bfe`（父任务提供）；此前功能基线：`05eddb7ebaf97f8e61139fd9f5e3f111aeb50237`。
- 当前验证的是新构建的 `dist/` 和 `dist/bundle/`。本轮未重新打包 tgz。
- 历史候选包仍在 `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/release/37soul-runtime.tgz`，SHA-256 为 `bb30472ffc2d728b4178c54ed341c13b82cfb6db8e62a3c9f6644f4e09502c31`；这是此前产物，**不代表本次 account-first 提交**。

## 验收边界与发布状态

发布继续暂停。本轮没有 push、合并、tag、GitHub Release、部署、安装或替换本机运行时；没有真实用户登录/授权、浏览器操作、原生宿主会话 trust/load/模型采用或付费提炼调用，也没有删除/合并旧本机资料。完整 npm suite 和合成子进程证明本地实现与边界，不能代替生产 API 或真实宿主验收。
后续发布另需明确授权；届时应先确认网站授权/目录/选择 API 与 runtime 兼容，重建并验证实际交付包，再协调 skill 与候选版文案，最后核验公开 curl/SHA 和经授权的有界真实会话。当前没有执行这些发布步骤。

## 本轮文件（完整路径）

### Runtime

- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/README.md`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/README.zh-CN.md`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/docs/new-native-hosts.md`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/package-lock.json`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/package.json`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/server.json`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/adapters/cursor.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/adapters/gemini-cli.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/adapters/types.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/agentd/source-index.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/assets/protocol.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/cli.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/extraction/scheduler.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/hook.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/hosts/cursor.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/hosts/gemini-cli.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/hosts/instructions.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/hosts/native-json-hooks.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/hosts/registry.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/hosts/types.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/index.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/install.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/local/agent-connect.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/local/bindings.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/local/cloud-account.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/local/cloud-selection.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/local/writer.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/account-first-connect.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/cli.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/hook.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/hosts-registry.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/install.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/local-agent-bundle.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/local-agent-connect.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/native-invoker.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/new-hosts-native.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/new-hosts-runtime.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/retired-bindings.test.mjs`

### Website

- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/controllers/api/v1/me/hosts_controller.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/controllers/cli_approvals_controller.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/controllers/mcp_controller.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/services/agent_kind.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/services/agent_soul_payload.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/views/agent_access/show.html.erb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/views/cli_approvals/show.html.erb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/views/informations/_local_soul_install.html.erb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/app/views/informations/agent_soul.html.erb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/agent_access/en.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/agent_access/ja.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/agent_access/zh_cn.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/cli_approvals/en.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/cli_approvals/ja.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/cli_approvals/zh_cn.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/agent_soul_en.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/agent_soul_ja.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/agent_soul_zh_cn.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/for_agents_en.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/for_agents_ja.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/for_agents_zh_cn.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/local_soul_install.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/pricing_en.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/pricing_ja.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/informations/pricing_zh_cn.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/welcomes/en.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/welcomes/ja.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/config/locales/views/welcomes/welcomes_zh_cn.yml`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/docs/superpowers/plans/2026-11-03-local-agent-connect.md`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/public/INSTALL_FOR_AGENTS.md`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/public/install.sh`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/public/llms.txt`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/requests/agent_access_host_binding_spec.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/requests/agent_docs_spec.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/requests/agent_soul_page_spec.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/requests/api/v1/me/host_soul_consent_spec.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/requests/cli_device_flow_spec.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/requests/local_agent_connect_spec.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/requests/local_soul_install_hosts_spec.rb`
- `/Users/jiangxin/projects/37soul/.worktrees/local-agent-connect/spec/services/agent_kind_spec.rb`

### Skill

- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/.claude-plugin/marketplace.json`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/.claude-plugin/plugin.json`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/CHANGELOG.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/README.ja.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/README.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/README.zh-CN.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/SKILL.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/agents/openai.yaml`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/marketplace.json`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/references/api-reference.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/references/operator-mode.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/references/persona-http.md`
- `/Users/jiangxin/projects/37soul-skill/.worktrees/local-agent-connect/tests/test_local_agent_contract.py`
