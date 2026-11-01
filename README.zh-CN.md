# 37Soul

[English](README.md) · **简体中文** · [日本語](README.ja.md)

一个持久的 Soul，贯穿你机器上的 **Claude Code、Codex、OpenCode、Hermes 和 Pi**，也在
37Soul.com 上。原始对话、代码和工具日志留在本地；只有 Soul 的身份、你的长期关系偏好和
可复用的经验，在你明确登录并授权某个 Soul 之后才会同步。

> **如实说明当前状态。** 本地运行时已针对真实 Rails API 实现并测试了登录、首次下载、
> 推送/拉取、撤销以及网站侧修正。四个宿主适配器有本地实机 smoke 证据（提取），但完整的
> 跨会话落地（网站修正 → 新的原生会话）仍在独立验证中；观察到的 CLI 版本记录在下面。
> 全量测试：Node 24 本地 383 例（没有 Node 18 二进制时跳过 Node 18 下限检查；未打包的
> checkout 会跳过 tarball 检查）。tag CI 在 Node 20 上跑同一套测试，最新 Release 为绿。

## 云在其中的位置

37Soul 本身免费使用。免费账号会在对话中带上她最近 **30 天** 的记忆；订阅会去掉这个
窗口——两种情况都不会删除数据——并增加用于照片和视频的 credits。把她绑定到你自己的
agent 不额外收费，Markdown / SOUL.md / MEMORY.md 导出对所有账号免费。

[价格](https://37soul.com/pricing?ref=mcp-readme-zh)

## 快速开始：新建一个 Soul

需要 macOS 或 Linux，以及 Node.js 18+。

```bash
curl -fsSL https://37soul.com/install.sh | bash
```

安装是匿名优先的：**零 HTTP 请求**，为检测到的 agent 写入 hooks，启动本地运行时，并创建
一个本地 `assets_only` profile。此时还不会上传任何内容。

用名字、性别、年龄（16–65）和至少 50 个字符的角色描述创建一个本地 Soul，然后在你的
agent 里使用它：

```bash
37soul soul create --name "Nyx" --sex female --age 24 \
  --character "小七是一位喜欢摄影与旅行的年轻女性，性格温和而独立，说话简洁自然。她喜欢先听清对方的想法，再分享自己的观察。" [--avatar ./avatar.png]
37soul soul select <soul_uid>
37soul status
```

重启 agent。新会话会加载这个 Soul。当你想让同一个 Soul 出现在网站上、并跨机器使用时，
登录并明确授权它。你填写的 profile 会变成公开的；私聊和个人记忆不会：

```bash
37soul login
37soul soul authorize <soul_uid> --categories identity,relationship,experience
37soul sync
```

`37soul login` 会打开授权页；第一次 sync 会注册这个 Soul，并开启按设备的 Consent。在此
之前，本地 Soul 和排队中的资产都留在本地，**不算**失败。登录后，网站可以修正身份和资产；
下一次本地会话会拉取这次修正。

## 快速开始：恢复网站上已有的 Soul

这是给已经在 37Soul.com 上有 Soul 的人的路径。

1. 用上面的命令安装运行时。
2. 运行：

   ```bash
   37soul login
   ```

3. 在授权页选择**已有的 Soul**，然后批准。
4. CLI 会收到这个设备的 scoped credential，并拉取 Soul、它的身份和你的长期资产。它会
   自动成为账号默认：

   ```
   Soul restored: <name> (<soul_uid>), <n> asset(s)
   ```

5. 重启 agent 继续工作。网站保留身份的 source of truth；本地会话使用下载的副本。原始
   对话从不上传。

如果选中的 Soul 还没到达，CLI 会明说，并让默认值保持未设置，而不是造一个相似的。连通后
运行 `37soul sync`。

## 验证

```bash
37soul status
37soul doctor
37soul soul list
```

- `status` 报告机器、scoped credential 数量，以及待处理/隔离的本地变更。`login required`
  表示本地可用，但还不会同步任何东西。
- `doctor` 在宿主暴露这些状态时区分 installed / loaded / trusted / gateway-only。只有本地
  发件队列不是错误。它的提示行跟随 `SOUL37_LANG`、`LC_ALL` 或 `LANG`（en / zh / ja）；
  CLI 的其余输出仍是英文。
- `not_run` 用于这个构建无法执行的检查（宿主的实机轮次、Node 20 CI、GitHub Release）。
  它永远不会被报告为通过。

## 什么会同步——什么不会

| 数据 | 存在哪里 | 同步 |
| --- | --- | --- |
| Soul 身份（名字、描述、角色、开场白） | 本地 + 37Soul | 登录 + Consent 之后；网站修正优先 |
| 关系资产（稳定的偏好、目标、约定的协作方式） | 本地 + 37Soul | 只同步已授权的类别 |
| 经验资产（可复用的方法） | 本地 + 37Soul | 只同步已授权的类别 |
| 原始对话、prompt、代码、工具日志 | 仅在本地 | **从不上传** |
| 旧版 brief / 对话回写（`log_turn`、`remember`、`resume`、`checkpoint`） | 旧版集成 | 在 assets 模式下停止，失败即关闭 |

Consent 按设备和 Soul 签发。`--categories` 是整体替换，不是合并。本地创建不等于授权：
本地创建的 Soul 需要运行一次 `soul authorize`。未授权的 Soul 留在本地发件队列里，永远
不会阻塞已授权 Soul 的 Pull。

## 四个宿主

| 宿主 | 本地观察到的版本 | 状态 |
| --- | --- | --- |
| Claude Code | 2.1.305 | 观察到真实的 CLI 提取和 hook 路径；完整落地待验证 |
| Codex | 0.163.0 | 官方 `hooks.json`；信任由 Codex 的 `/hooks` 管理；观察到一次性绕过 |
| OpenCode | 2.0.32 | v2 插件可加载；观察到实机提取/trace；完整注入待验证 |
| Hermes | 0.21.0 CLI | 官方 shell hooks 可加载；观察到实机提取/trace；完整注入待验证 |
| Pi | 1.4.0 | 受管扩展可加载，四个桥接事件都会触发（2026-10-30 观察到 session_start / prompt / settled / shutdown）；结构化提取**未验证** |

仅网关（gateway-only）的 Hermes 配置不算 CLI 支持，也会如实报告。
`37soul install --plan` 只列出文件、不写入。安装器会备份它改动的每个用户文件；
`37soul uninstall` 只删除受管文件，保留 `~/.37soul/profiles/`、原始 spool 和未同步队列。

## 本地运行时细节

- 一个 writer 进程串行处理所有本地变更。Hooks 通过本地 socket 投递事件；它们从不直接写
  snapshot，也从不阻塞宿主。
- 重复安装会保留已有的 profile、Soul UUID 和资产。Scoped credential 在重装后仍然有效；
  全局的旧版 token 绝不会被复用到另一个 profile。
- 早先的 bind ACK 到达时，离线 bind/detach 的意图会被保留。Binding ACK 只推进
  `cloud_revision`；更新的本地 detach 或切换会保持为意图，直到它自己的操作被确认。
- 撤销（包括已撤销设备上 Rails 返回的 `token_invalid`）会清掉下载的云端缓存和 scoped
  credential，但保留本地原件和未同步资产。
- 运行时支持 Node 18 ESM；tarball 不含原生模块，也不含 WASM。

## 发布运行时

`install.sh`（由 Rails 应用从 `public/install.sh` 提供）会取
`releases/latest/download/37soul-runtime.tgz` 及其 `.sha256`。要发布新运行时，先升
`package.json` 的版本，再推一个匹配的 tag。`.github/workflows/release-runtime.yml` 会跑
`npm test`、用 `scripts/pack-runtime.sh` 打包，并校验布局和摘要；也可以通过 **Run
workflow** 手动触发。这个 workflow 只构建和校验——把 tarball、`.sha256` 和 `VERSION`
作为 GitHub Release 发布是另一个需要明确授权的步骤。

```bash
git tag v0.11.6 && git push origin v0.11.6
```

Tarball 的根目录是 `37soul/`，包含 `package.json`、`dist/bundle/{cli,index}.js`、受管的
OpenCode 桥接，以及 Hermes 桥接源码。`release/VERSION` 必须等于 `package.json` 的版本；
`.sha256` 是对实际 tar 字节的摘要。

## 托管/远程 MCP（与本地运行时相互独立）

无法运行本地运行时的客户端仍可使用托管服务器：

```
https://37soul.com/mcp
```

它在 MCP Registry 中的名字是 `io.github.Qumge/37soul-mcp`。

## 运行时如何分发（npm 不是渠道）

本地运行时**只**以经过校验的 tarball 形式发布在 GitHub Releases 上，由
`https://37soul.com/install.sh` 获取。我们刻意不把它发布到 npm：

- npm 会在一个我们本来就能自己校验的二进制之上，引入我们无法控制的生态（安装脚本、
  registry 策略、镜像漂移、审计噪音）。
- 安装器会校验 SHA-256，并且可以按 release 锁定版本；包管理器给不了用户这条审计链。
- npm 的包体积限制和生命周期钩子会逼我们做削弱「原文留在本地」这一叙事的打包取舍。

所以 `npm install -g 37soul-mcp` 不是受支持的运行时获取方式；npm 包自 2026-10-06 起就
没有再发布（`npx 37soul-mcp` 仍会运行 0.9.0，仅作历史保留）。MCP Registry 条目只列出
**托管**服务器（`https://37soul.com/mcp`），不指向任何 npm 包。托管 API 提供账号、聊天
和发帖操作；它不是本地持久 Soul 的提取路径。在 assets 模式下，旧版对话写入工具
（`log_turn`、`remember`、`resume`、`checkpoint`）会被禁用，返回
`410 assets_only_mode`。

## 共享契约 fixture（两仓库同步）

`soul-assets/v1` 契约测试从随仓库携带的 fixture 读取基准数据，从不使用每个测试手写的
期望值：

- 权威来源：相邻的 **37soul**（Rails）仓库中的
  `docs/superpowers/specs/2026-10-20-persistent-soul-fixtures.json`；
- 携带副本：`test/fixtures/contracts/soul-assets-v1.json`；
- 来源 + 摘要：`test/fixtures/contracts/source.json`。

`test/helpers/contract-fixture.mjs` 每次加载都会按声明的协议和 SHA-256 校验字节。CI
只依赖仓库内的 fixture。需要协同更新时：

```bash
SOUL37_CONTRACT_FIXTURE=/path/to/37soul/docs/.../2026-10-20-persistent-soul-fixtures.json npm test
```

携带副本和声明的哈希要一起更新。

## 许可证

MIT
