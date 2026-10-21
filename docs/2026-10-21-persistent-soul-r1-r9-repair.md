# 37Soul B 组 R1–R9 修复执行记录

日期：2026-10-21

> **MVP 后续（同日）：** 本文件记录的 0.11.2 是 R1–R9/F1–F3 复审基线。之后补了
> Task 0 同 Session 改选残留、重复安装保留凭据、首次恢复默认 Soul、状态文案、
> 真实宿主接入（Claude/Codex/OpenCode/Hermes）、按任务 hint 的 before-prompt 注入、
> 同版本云端资产状态收敛和 Node20 本地测试，最终候选为 **0.11.6**，tar hash
> `b4c62071f33cbaa522c9f0a4c2ce2c8e342f470b030a885a991bc371fc496075`。
> Node18.20.4 / Node20.20.2 / Node24.18.0 均 330/330；四工具实机、GitHub CI、
> 发布和生产仍未执行。详细验收以
> `37soul/docs/superpowers/plans/2026-10-21-persistent-soul-mvp-launch.md` 为准。
>
> **上线复审 P1 补修：** lifecycle enqueue 与 worker claim 拆开；pending 不再被
> duplicate_turn 拒绝，claim 原子计数（每范围/绑定至多 2 次），运行中 claim 防止
> 并发双跑，失败可重试。长会话按冻结 turn refs 读取有界尾部窗口，refs 不解析或
> turn 文本为空一律 `source_unavailable`，不再零结果完成。Claude 原生 user 容器内
> 的 tool_result 标为 `Tool result`，不再伪装成 User 长期偏好。

分支：`fix/persistent-soul-r1-r9`
提交：`c5a8350`（R1–R9）+ `5ccd6e6`（F1–F3 补修）；运行包版本 `0.11.2`
Skill：`feat/persistent-soul` @ 6.11.3
主仓库：`feat/persistent-soul-a` @ `e1a479f9`（未修改本轮 B 代码；用户原有文档保持未跟踪/未提交）

## 结论

R1–R9 代码修复、离线测试、Node 18/20/24 完整测试、实际 Rails 本地往返和重新打包已完成。
四工具真实宿主探针、20 方向迁移矩阵、发布和生产部署未执行。

## R1–R9 + F1–F3

| 项 | 修复 | 主要测试 |
| --- | --- | --- |
| R1 账号串线 | `src/agentd/credentials.ts` 按 profile/owner/cloud device/runtime 保存凭据；`syncOnce` 不再回退全局 `config.tokens`；`loginCommand` 保存 scoped credentials | `sync-run.test.mjs` R1 / legacy token tests |
| R2 首次登记空授权 | `create_soul` 只创建本地 Soul；新增真实 CLI `37soul soul authorize <uid> --categories ...`；旧空登记 422 进入 `authorization_required` 隔离 | `cli.test.mjs` R2；`sync.test.mjs` R2 |
| R3 runtime 凭据混用 | binding 按 `runtime_kind` 选 token；资产按 `payload.source.runtime_kind` 分组，Pull/control 用同设备凭据 | `sync-run.test.mjs` R3（四 binding + 四资产） |
| R4 撤权后继续注入 | 撤 Consent/设备时清理云端缓存与身份，保留本地原创；Hook 捕获 `identity_not_authorized`；设备/token 撤权清理 scoped credentials | `sync.test.mjs` R4；`hook.test.mjs` revoked identity |
| R5 响应头后无界等待 | `withTimeout` 计时保持到 body 完整消费；重试前取消 body；writer 超时后可处理下一条命令 | `sync-run.test.mjs` R5 localhost stalled-body |
| R6 补传丢失来源 | 本地资产保存冻结 binding UID/revision；补传使用 UUID `change_id`；失效来源隔离且不发送 | `sync.test.mjs` R6 / re-authorization tests |
| R7 同版本解绑被跳过 | Binding 分开 `cloud_revision` 与未确认本地修改；同版本云端 detach 生效，本地提案保留 quarantine | `sync.test.mjs` R7 直接 Pull + 409→Pull |
| R8 解绑被自动复活 | `resolveBinding` 对 detached 记录返回 null，只有显式 `selectSoul` 才同记录递增恢复 | `profiles-bindings.test.mjs` R8 |
| R9 冲突屏蔽确认副本 | `ownerContextInput` 只排除未确认本地提议；已 `synced` 且 `cloud_revision` 的当前对象可注入 | `sync.test.mjs` R9 |
| F1 未授权 Soul 阻塞同步 | push binding/asset 前检查 identity Consent；未授权操作保留本地 outbox、不出站，Pull 继续 | `sync.test.mjs` F1、`cli.test.mjs` F1、实际 Rails F1 |
| F2 较早 bind ACK 覆盖 detach | Binding ACK 只推进 `cloud_revision`；较新的本地 detach/改选保持当前状态，恢复网络后继续发送 | `sync.test.mjs` F2（真实 select/detach） |
| F3 本地编辑不生效 | `edit_local_identity` 同时更新 `identity`/`local_identity` 与两者 revision；Hook/export 使用最新本地身份 | `cli.test.mjs` F3、`hook.test.mjs` local edit |

## 验证

```sh
# Node 24.18.0
SOUL37_HOME="$(mktemp -d)" npm test
# 299 tests, 299 pass, 0 fail, 0 skipped; smoke all checks passed

# Node 18.20.4
PATH=/tmp/37soul-node18/node-v18.20.4-darwin-arm64/bin:$PATH \
  SOUL37_HOME="$(mktemp -d)" npm test
# 299 tests, 299 pass, 0 fail, 0 skipped; smoke all checks passed

node scripts/probe-runtime.mjs --offline --runtime all
# exit 0; four runtimes remain 0.0.0-unverified / supported_version null
```

实际 Rails 本地测试环境（`RAILS_ENV=test`，合成账号/设备/token，无真实模型）：

- 两个不同 owner/profile 各自注册 Soul、Consent、四 runtime Binding、四 runtime 资产；各自 4/4 synced。
- 同一 root 下 `runSyncProfiles` 两 profile 分别使用自己的 token；profile A 未收到 profile B 的 Soul。
- 真实 Rails Consent 收窄到 identity：本地 relationship 资产被清理，身份保留。
- 真实 Rails 设备撤权（PAT 先失效返回 `token_invalid`）：本地云端 Soul/缓存与 scoped credentials 被清理，本地原创保留。
- 真实 Rails 重新授权 relationship：本地 local_only 资产携带冻结 Binding 补传成功为 synced。
- HTTP 请求/日志未出现 token、native session id、原文/路径或渲染文本。

## 关键反向验证（临时变异后已恢复）

- R2：把 `authorize_soul` 的 `consent_categories` 改回 `[]` → `cli.test.mjs` R2 红
  （actual `[]`，expected `["identity","relationship"]`）。
- R3：把 binding 的 runtime token 选择改成 `auth.defaultToken` → `sync-run.test.mjs`
  R3 红（Codex binding 收到 `Bearer token-claude-code`）。
- R5：在收到响应头时 `clearTimeout` → R5 localhost stalled-body 测试红
  （`test-timeout`，writer 未在承诺时限内返回）。
- F1：恢复“所有 binding 直接发送” → 真实 CLI F1 回归红（A 的 binding 出站）。
- F2：ACK 恢复整对象覆盖 → 真实 select/detach F2 回归红（detach 被改回 bound）。
- F3：只更新 `identity`、保留旧 `local_identity` → 真实 CLI F3/Hook 回归红（渲染旧人格）。

## 运行包

```text
release/37soul-runtime.tgz
version: 0.11.2
sha256: f5f0480599edd710960c8063f030a27e3b1c3755be13f3fc781c32021355d63a
release/VERSION: 0.11.2
release/release-manifest.json version/hash 一致
```

tar 根为 `37soul/`，包含 `dist/bundle/cli.js` / `dist/bundle/index.js`；解包到独立目录后无 `node_modules` 可执行 `--help`，exit 0。

## 未执行 / not_run

- Node 20 完整测试：本机无该二进制，not_run。
- Claude Code / Codex / OpenCode / Hermes 真实宿主探针、真实模型结构化提炼、真实注入行为：未获真实配置/付费模型授权，not_run。
- 四工具 12 个有向组合 + 网站 4+4 方向：not_run；不能从离线 stub 或本记录推断 pass。
- npm 发布、GitHub Release、生产部署、生产核验：未执行。
