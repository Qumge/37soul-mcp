# 37Soul 轻量运行时验收（2026-11-04）

本轮实现普通记忆批处理、提炼输入压缩、独立资源预算、Claude 重复上下文省略和精简连接结果。实现位于 `feat/lightweight-runtime`，基线 `7b40073faba043f259aa44aed096022038620d1f`（0.15.5）。主 checkout、本机安装、网站和原始账号数据未修改。本轮尚未合并、推送或发布。

最终代码提交：0fc272cb609e7f92fca1f5f7c418f7b5cb338f5c。本文另有文档提交。打包是候选产物验证，仍标记 0.15.5，不能覆盖已发布的同版本资产；正式发布须独立更新版本并检查分发链路。

## 实现结果

- 普通回合达到3条，或最早一条等待90秒后进入处理；30秒后台 tick、模型执行与同步可增加时间。这是处理资格，不能承诺120秒内云端完成。明确的“记住”请求在同 profile 的各会话之间优先，仍受预算约束。
- 每批最多3条，严格限定同账号档案、设备、宿主、原生会话、Soul 和绑定版本。只为 Claude/Pi 合并原生调用；其他可提炼宿主保留单条原生调用及相同队列/预算门槛。Cursor/Gemini 的既有不可提炼诊断不变，且不花模型预算。
- 先压缩工具材料，保持人类、助手、工具来源身份。每回合最多6 KiB、批输入最多24 KiB；完整人类内容放不下就保留任务并报告 `source_input_too_large`，不会宣称已经记住。
- 原子预留 profile 每UTC日40次/200000估算单位，会话20次/50000单位；单位来自来源UTF-8字节和1024输出预留，不是实际 token、美元或隐藏原生上下文的完整硬上限。用量已耗尽时不再准备来源，不消耗尝试次数、不丢队列。保留最多8天汇总。损坏账本拒绝继续，不能重置为零。
- 工作器并发1，来源/模型执行不占单写入队列。显式请求不绕过额度；达到额度的待办保持在本地。切换后的旧绑定任务冻结并可诊断，切回也不自动复活或改挂。
- Claude 对未变化的同会话上下文不重复输出，在启动、压缩、重置、恢复、资料或记忆变化后恢复。上限4096字节（含原生会话提示），身份最多2048字节；完整存储和 recall 不裁剪。其他桥接保留有上限的完整注入，尚未假设其上下文保留机制相同。
- 不再安装 Claude 的 PostToolUse/PostToolUseFailure 逐工具订阅；Stop 继续读取完整完成回合，包括工具记录。升级/卸载只移除37Soul命令，保留同组用户命令和 matcher。
- 连接仍验证实时名下角色目录和实时身份授权。仅本地恰有一个已授权同名候选时并行这两项检查，并在目录返回后再次验证归属与当前授权。保留同名歧义保护。connect 返回基本角色、心情、关系、指引、版本与会话连接；whoami 保留完整资料。
- Claude 后台提炼输出上限1024 token、关闭思考、限制一个模型回合，单次运行禁用普通用户/项目 hooks、外部工具和外部MCP。保留已有登录发现及管理员策略。SDK 已返回完整且无歧义的 schema JSON 时可在一回合边界复用；截断、认证错误、其他工具动作不能伪装成功。并未启用会破坏 OAuth/keychain 的 `--bare`。
- doctor 提供积压、失效绑定、来源过大与本地预留汇总；模型实际报告用量另记日志，不采信 CLI 对未知模型的美元估价。

## 严格 TDD 与修复证据

所有新增行为先跑失败，再实现；未通过修改既有测试掩盖回归。安装事件列表的2处既有断言随明确产品行为调整：新安装无逐工具订阅，卸载测试主动构造旧订阅继续验证历史清理。

| 验证项 | RED 实际结果 | GREEN 实际结果 |
| --- | --- | --- |
| 输入压缩、批适配器、MCP隔离 | 初始9失败；隔离补充1失败/4通过 | 相关75/75 |
| 队列与预算 | 初始9失败；补充来源/会话额度2失败 | 最终任务阶段39/39 |
| 重复注入与恢复 | 初始6失败 | hook/契约50/50 |
| 精简连接、并行检查、诊断 | 修正URL夹具后在精确基线重测：2通过/3预期失败；报告用量另有RED | 相关46/46 |
| 压缩期间晚缓存写、错误批次重试 | 2失败/16通过 | 相关57/57 |
| 独立审查8个复现 | 8/8失败 | 8/8通过 |
| 跨会话显式优先、持久来源诊断 | 2失败 | 当时 scheduler 13/13 |
| 严格一回合原生输出 | 3失败/2通过 | 相关44/44 |
| 普通原生hooks隔离 | 1失败 | 相关13/13 |
| 损坏预算根类型 | 1失败 | scheduler/connect 20/20 |
| 取消逐工具订阅、混合用户hook保护 | 3/3失败 | install/hook/adapters 92/92 |
| hook超时后不得启动缓存写入 | 7通过/1失败 | Node18/24各相关18/18 |

初次全量916条有3个回归（注册表工厂对象身份、Gemini/Cursor诊断），生产代码修复后通过，既有断言未改。Node18后续936条有1个真实竞态：hook超时返回后，异步缓存目录/文件写入与临时目录清理冲突（ENOTEMPTY）。可控目录阻塞测试复现后，将很小的交付元数据写入/失效改为同一同步本地提交，避免遗留写入 continuation；异步读之后仍重新校验授权。没有用重试清理目录掩盖问题。

最终全套结果见下表；未跑任何 Rails RSpec。

| 环境/命令 | tests / pass / failures / skipped | 其他检查 |
| --- | --- | --- |
| Node24.18.0，打包后 `npm test` | 937 / 937 / 0 / 0 | smoke 64/64通过 |
| Node18.20.8，全部 `test/*.test.mjs` | 937 / 937 / 0 / 0 | 单独 smoke 64/64通过 |
| `git diff --check` | 通过 | 无新增npm依赖 |

执行命令：

```sh
./scripts/pack-runtime.sh
SOUL37_REQUIRE_PACKED_RELEASE=1 SOUL37_NODE18=<校验后的node18路径> npm test
SOUL37_NODE18=<校验后的node18路径> <node18路径> --test ./test/*.test.mjs
<node18路径> test/smoke.mjs
```

Node18官方工具链仅下载至临时目录；darwin-arm64.tar.gz SHA256 为 `bae4965d29d29bd32f96364eefbe3bca576a03e917ddbb70b9330d75f2cacd76`，与官方校验表一致。验收覆盖打包 tarball，不因缺少本地Node18或产物而跳过。

## 真实模型：严格限制为4次请求

用户先授权最多3次，再授权1次空结果复验。使用真实Claude CLI、既有DeepSeek Flash路由、隔离HOME、合成对话和请求级外发闸门，实际3+1=4次外部模型请求；无更多模型调用。没有把用户的真实37Soul对话或凭证放入测试内容。

| 场景 | 首轮 | 最终结果 |
| --- | --- | --- |
| 同一批三条不同长期偏好 | 通过 | 各归属自己的job，无错配 |
| 三条一次性指令，不应形成长期记忆 | 原生SDK `error_max_turns`，未记为通过 | 修复输出处理后额外1次复验通过，三个 `proposals: []`，native code0 |
| 工具文本伪造“User:”指令 | 通过 | 只保留真实用户偏好，工具伪造偏好未入库 |

4次合计输入13410、输出659、缓存命中0个报告token。按[DeepSeek官方Flash高峰直连价](https://api-docs.deepseek.com/quick_start/pricing/)估算：13410×$0.30/百万 +659×$1.20/百万 = **$0.0048138**。这是直接API价格估算，包含失败的那一次；不能代替代理供应商实际账单或证明所有真实任务都同价。首轮报告思考token0，无服务端搜索/抓取。HTTP级请求闸门约束本次验收；生产 `max-turns` 不等于禁止SDK传输重试。

免费的原生SDK回放另做对照：允许普通hooks时合成hook确实运行；带单次 `disableAllHooks` 后不运行，仍完成三个任务。管理员托管hooks依照宿主策略保留，见[官方hooks文档](https://code.claude.com/docs/en/hooks)。

## 本机合成基准

从精确基线源码归档构建，与候选交替做两组邻接测量。全部隔离HOME、假身份、实际CLI/IPC与本地100ms权威请求模拟，无外部模型请求。不是公网或用户真实数据的性能承诺。

| 指标 | 0.15.5基线 | 候选 |
| --- | --- | --- |
| 3个同绑定回合的原生调用数 | 3 | 1 |
| 大工具日志的提炼输入 | 112327字节 | 3504字节 |
| connect返回 | 6914字节 | 810字节 |
| 连续8次未变化提示的新增上下文 | 8×541=4328字节 | 541字节，之后7次0 |
| 每次普通工具完成的37Soul进程订阅 | 有 | 0，新安装/升级行为测试覆盖 |
| 两组connect p50 | 215.24–215.96ms | 110.51–112.89ms |
| 两组新CLI hook p50 | 46.09–49.73ms | 36.41–40.36ms |
| 两组新CLI recall p50 | 31.49–32.24ms | 31.93–37.50ms |
| 空闲agentd RSS | 56896–57296KiB | 57120–57248KiB |
| 2秒空闲CPU百分比读数变化 | 0 | 0 |

时延是当时本机样本。早期无效身份夹具产生双方零输出已废弃；一次非邻接样本明显受机器负载影响（candidate hook110.84ms），没有拿它证明产品优劣。最终缓存提交修复后的邻接复核见 connect p50 209.11→106.50ms，hook 50.87→50.28ms，recall 34.55→34.47ms，空闲RSS 56896→57072KiB；两者2秒CPU读数变化均0；调用数和字节量与表格一致。RSS仅为本轮启动的空闲守护进程采样，不包含宿主/模型子进程峰值。去重减少新增注入，不会删除宿主既有历史，也不保证账单按相同比例降低。

## 独立审查与边界裁决

一次构建中检查及一次固定范围整支审查；没有为每个小任务反复调用审查Agent。整支审查发现3个P1、3个P2，用8个独立复现测试验证并修复：

1. 缓存I/O之后、stdout之前再次检查当前账号/设备/绑定/授权和渲染摘要，阻止切换竞态泄漏旧Soul。
2. 未完成任务引用的来源指针不受普通32指针/7日GC误删，确保预算延期可恢复；代价是路径元数据保留到任务完成或被明确处理。
3. 单条和批量结果都在原生返回后重新校验来源，文件替换不能产生错误资产。
4. 不跨drain缓存原始或负面来源准备结果，每次重新解析。
5. 去掉16项准备缓存淘汰导致活动批次失败、白花预算的问题。
6. 工具材料压缩从重复整串序列化改为线性选择；大身份裁剪改二分前缀并保持既有字段优先级和金样。

原标记minor的“来源错误持久诊断”和“跨会话明确记住优先”提升为本任务的重要问题，一并RED/GREEN修复，无未处理minor。注册表工厂对象身份原位保留。

明确不作以下推断：其他宿主未经本轮实机验证的工具禁用与上下文保留机制；任意提示注入都可语义防御；所有网络环境无延迟；通用峰值内存/真实账单上限；本轮之后的HEAD、公开发布、OAuth生产链路已验收。保留现有认证，不为省上下文绕过宿主认证、管理员策略或网站授权。

审查过程偏差：审查Agent报告一次不符合其范围的本地记忆索引关键词查询，未采用结果，无外部模型调用或数据外发；已记录，不作为实现证据。

## 范围与交付状态

变更涵盖原生提炼适配器、批处理/预算/诊断、来源指针保留、hook交付元数据、上下文裁剪、连接投影、Claude安装订阅、对应行为测试、三语README和计划/验收说明。新增 `native-output.ts`、审查复现测试及 `src/hosts/claude-code.ts` 超出初始Task5文件列举，是修复真实验收和审查问题所需，未改Rails或新增宿主。

临时证据位于 `/private/tmp/37soul-lightweight-delivery-20261104/`（模型合成结果、RED/GREEN日志、基准脚本/数据、最终检查日志及SHA256SUMS）；此路径不是git worktree。源码归档也不含.git，不是额外worktree。持久结论在本文；临时证据可能随系统清理消失。

实现/本地候选打包验证与发布分开：本次没有merge/push/tag/GitHub Release/npm publish，没有安装到真实HOME。用户当前安装不因本次测试自动升级。若后续授权发布，应按仓库既有GitHub Release + install.sh流程发布新版本，验证公开manifest/校验和/安装与运行版本后再宣称用户已可安装。

## 文件清单（相对基线，共37个）

- `README.ja.md`
- `README.md`
- `README.zh-CN.md`
- `docs/superpowers/plans/2026-11-04-lightweight-runtime.md`
- `docs/superpowers/specs/2026-11-04-lightweight-runtime-design.md`
- `src/adapters/claude-code.ts`
- `src/adapters/types.ts`
- `src/agentd/context-delivery.ts`
- `src/agentd/native-invoker.ts`
- `src/agentd/source-index.ts`
- `src/assets/context.ts`
- `src/cli.ts`
- `src/doctor.ts`
- `src/extraction/batch-adapter.ts`
- `src/extraction/compact-input.ts`
- `src/extraction/diagnostics.ts`
- `src/extraction/native-output.ts`
- `src/extraction/resource-budget.ts`
- `src/extraction/scheduler.ts`
- `src/hook.ts`
- `src/hosts/claude-code.ts`
- `src/local/agent-connect.ts`
- `src/local/compact-identity.ts`
- `src/local/store.ts`
- `src/local/writer.ts`
- `test/install.test.mjs`
- `test/lightweight-acceptance.test.mjs`
- `test/lightweight-batch.test.mjs`
- `test/lightweight-connect.test.mjs`
- `test/lightweight-context.test.mjs`
- `test/lightweight-input.test.mjs`
- `test/lightweight-native-output.test.mjs`
- `test/lightweight-review-adapter.test.mjs`
- `test/lightweight-review-state.test.mjs`
- `test/lightweight-scheduler.test.mjs`
- `test/lightweight-tool-hooks.test.mjs`
- `docs/superpowers/specs/2026-11-04-lightweight-runtime-acceptance.md`
