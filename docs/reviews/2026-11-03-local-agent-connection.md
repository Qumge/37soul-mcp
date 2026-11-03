# 本机 Agent 接入修复验收 — 0.15.0 候选版

状态：实现、提交和本地验收完成；未 push、未合并、未创建 tag/Release、未部署网站、未替换本机安装。不能把本报告当作 curl 已经可安装新版的证明。

## 修复后的流程

- 角色页提供 `37soul login --host ID`，批准页要求该自有角色，下载成功后才报告角色就绪。普通账号授权仍允许无角色，但会明确说明尚未接入。
- `37soul whoami --host ID` 从现有存储内部选择服务器、账号、设备、profile、宿主相符的凭据。需要已恢复角色和 identity 同意，不转向远程 OAuth，不打印 token。请求前后都复核同意；relationship/experience 关闭时不会输出其衍生内容。
- 设备 PAT 的 HTTP 身份读取按实时同意受控；设备 PAT 通过远程 MCP whoami 绕行时被明确拒绝并指向本机命令。无设备的远程 PAT/OAuth 行为保留。
- `37soul connect --host ID --agent KIND --session NATIVE_ID` 只绑定 hook 提供的准确原生会话。切换生成新的不透明云端 session_ref；本地字节边界、文件身份和摘要指纹隔离旧记录。旧作业不能写到新角色，压缩/替换来源后可显式重新接入。
- 撤销私有身份后，hook 仅可提供非私密的原生会话恢复参数；暂停时仍完全静默。连接提交前后复核活动 profile，防止并发换账号后误报 attached。
- 复用同一有效账号的资料；未知来源或不同账号的旧 profile 未自动合并、未删除。共享 skill 安装副本也未改动。

## 新增宿主的实际范围

Gemini CLI、Cursor 新增原生 hook 配置、事件解析、身份上下文和来源记录，以及只清理受管项的卸载和保守诊断。现有五个宿主保留。
两者暂未启用自动记忆提炼：无法确认原生后台调用能完全禁用工具与 MCP。适配器返回明确不可用状态，不调用模型、不使用其他 CLI 或云端模型兜底。没有把“配置存在”当成信任、加载、模型采用或提炼成功。官方证据及各自边界见 ../new-native-hosts.md。

## 验证

- 严格先失败后实现：初始连接测试 11 项、9 失败；来源压缩/原地重写补测 2 失败；原生格式/未知会话补测 2 失败；独立复核的同意/账号竞态/恢复补测 4 失败；响应期间撤权/收窄补测 2 失败。最终连接文件 24 项全部通过。初始已有的参数拒绝用例可在缺少命令时通过，未把它们计作修复证据。
- 最终运行时 `npm test`：698 tests，697 pass，0 fail，1 skip（本机没有 Node 18 二进制）；MCP smoke 全部通过。打包后产物校验已执行，未跳过。
- 独立 bundle 验证：复制单文件 CLI 到无 node_modules 的目录，真实子进程访问合成 HTTP 服务，并通过真实本地 writer IPC 接入准确会话。1 test，0 failures。此证据不是生产 API 或真实宿主模型验收。
- 网站最终 15 个定向 spec：341 examples，0 failures；Ruby 4.0.1，隔离数据库 yu_test_soul_growth，Redis /13。未跑全量 rspec 或共用 yu_test。
- skill：10 个文档契约测试全部通过；skill 验证器通过。
- 父进程使用 Node v24.18.0。网站定向复跑首次被沙箱禁止连接本机 PostgreSQL；授予本机测试库访问后，同一组 15 个文件得到 341/0。这是环境准备失败，不是产品断言失败。
- 三种语言、接入页和批准页、1440px/390px 共 12 个渲染检查，无横向溢出、缺翻译或错误目标选择。批准表单确认为 host 277、required=true。父 Agent 用 ego-browser 再核对最终中文桌面页及手机批准页；均为合成数据，没有批准真实账号。
- 独立代码复核发现的问题均已补回归并修复；核心修复最终没有剩余的已确认 P1/P2。新宿主复核发现的 Gemini 禁用状态保留及 doctor 名称规则问题，已在 `08351cc` 补先失败后通过的回归；复核确认这两处问题关闭，没有剩余的已确认 P1/P2。

## 提交与候选包

- Runtime 原生宿主：`48fd3144b00e5acbe52c97d52dd99dfc2de3d043`。
- Runtime 核心修复：`6a47a77`；Gemini 禁用状态复核修复：`08351cc72339aec49747645ecf2b1bc1fc5e8f65`。
- 网站功能：`05eddb7ebaf97f8e61139fd9f5e3f111aeb50237`；计划记录：`2db9c8a3`。
- skill 最终：`3d920c8ab5fd7625ddc5f290b315f5fd3ff9715f`，版本 6.12.3。
- 候选包：`/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/release/37soul-runtime.tgz`。
- SHA-256：`bb30472ffc2d728b4178c54ed341c13b82cfb6db8e62a3c9f6644f4e09502c31`。

## 验收边界与后续发布顺序

没有执行真实宿主会话的加载/批准/模型采用测试，没有付费提炼调用，没有真实用户重新登录/授权，没有删除或合并任何本机旧数据。Node 18 需在对应 CI 环境补验，不能用本机 Node 的通过替代。
发布应先部署网站的授权和宿主白名单更新，再发布 Runtime 0.15.0 和 skill，最后验证公开 curl 产物与 SHA，并在用户确认的目标账号/Soul 上做有界真实验收。当前网页和 skill 中的候选版提示是有意保留的，发布时应同步改成正式版本提示。

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
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/src/local/writer.ts`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/cli.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/hook.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/hosts-registry.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/install.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/local-agent-bundle.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/local-agent-connect.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/native-invoker.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/new-hosts-native.test.mjs`
- `/Users/jiangxin/projects/37soul-mcp/.worktrees/local-agent-connect/test/new-hosts-runtime.test.mjs`

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
