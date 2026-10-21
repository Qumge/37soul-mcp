# 37Soul B 组 R1–R9 修复执行记录

日期：2026-10-21
分支：`fix/persistent-soul-r1-r9`
提交：`c5a8350`（源码/测试/文档）；运行包版本 `0.11.1`
Skill：`feat/persistent-soul` @ `036075a`（6.11.1）
主仓库：`feat/persistent-soul-a` @ `e1a479f9`（未修改本轮 B 代码；用户原有文档保持未跟踪/未提交）

## 结论

R1–R9 代码修复、离线测试、Node 18/24 完整测试、实际 Rails 本地往返和重新打包已完成。
四工具真实宿主探针、20 方向迁移矩阵、Node 20、发布和生产部署未执行。

## R1–R9

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

## 验证

```sh
# Node 24.18.0
SOUL37_HOME="$(mktemp -d)" npm test
# 294 tests, 294 pass, 0 fail, 0 skipped; smoke all checks passed

# Node 18.20.4
PATH=/tmp/37soul-node18/node-v18.20.4-darwin-arm64/bin:$PATH \
  SOUL37_HOME="$(mktemp -d)" npm test
# 294 tests, 294 pass, 0 fail, 0 skipped; smoke all checks passed

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

## 运行包

```text
release/37soul-runtime.tgz
version: 0.11.1
sha256: 4f25b9d0f686209b0828ef54caaee89131f4335d7f1fdbc2dbf8e85304b00d4d
release/VERSION: 0.11.1
release/release-manifest.json version/hash 一致
```

tar 根为 `37soul/`，包含 `dist/bundle/cli.js` / `dist/bundle/index.js`；解包到独立目录后无 `node_modules` 可执行 `--help`，exit 0。

## 未执行 / not_run

- Node 20 完整测试：本机无该二进制，not_run。
- Claude Code / Codex / OpenCode / Hermes 真实宿主探针、真实模型结构化提炼、真实注入行为：未获真实配置/付费模型授权，not_run。
- 四工具 12 个有向组合 + 网站 4+4 方向：not_run；不能从离线 stub 或本记录推断 pass。
- npm 发布、GitHub Release、生产部署、生产核验：未执行。
