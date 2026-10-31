# 37soul-mcp — Agent 协作规范

本文件是仓库内所有 AI Agent（Claude Code、Codex、Cursor、pi、Qoder、Kiro 等）的统一入口规范。任何 Agent 进入本仓库都必须遵守。

## Git worktree 规范

1. **位置统一**：worktree 只准放 `<仓库根>/.worktrees/<目录名>/`，禁止散到 `~/.codex/worktrees/`、`.claude/worktrees/`、`~/.local/share/opencode/`、`/tmp/` 等各工具默认路径。

2. **命名可预测**：目录名 = 分支名去掉前缀（`codex/`、`fix/`、`feat/`、`chore/`…），`/` 换成 `-`。
   - `fix/screen-protection-lite` → `.worktrees/screen-protection-lite`
   - `codex/cmo-demo-preview` → `.worktrees/cmo-demo-preview`

3. **建法**：`git worktree add .worktrees/<目录名> -b <分支名>`（`.worktrees/` 已在 `.gitignore`，不进仓）。

4. **生命周期**：合并进 `main` 并 push 后，当场 `git worktree remove` 清掉；删前先 `git status --short` 确认无未提交工作；`remove` 只删目录不删分支。

5. **唯一例外**：工具强制的临时沙箱，用完 `git worktree prune` 清注册。

## 发布与分发（硬规则）

**npm 不是分发渠道。不要 `npm publish`，不要把用户引到 `npm install -g 37soul-mcp`。**

运行时只通过一条链路到达用户：

```
GitHub Release vX.Y.Z（37soul-runtime.tgz + .sha256 + release-manifest.json + VERSION）
  → https://37soul.com/install.sh 下载并校验 SHA-256
  → 37soul install 写各宿主适配器 → 37soul login 设备码授权
```

理由（写在这里是为了不让下一个人重新论证一遍）：

- npm 引入了我们控制不了的一层：安装脚本、注册表策略、镜像漂移、审计噪音。
- `install.sh` 能自校验 SHA-256、可按时锁定版本，注册表给不了这条审计链。
- npm 的体积限制与生命周期钩子会逼我们做削弱「原文留在本地」的打包取舍。

`npm test` 仍然是本地测试入口（与发布无关）；`scripts/bump-version.sh` 会同步
`package.json` / `src/index.ts` 的 `MCP_VERSION` / `server.json`（Registry 条目指向的是
托管端点 `https://37soul.com/mcp`，不是 npm 包）。

发版步骤：

```bash
./scripts/bump-version.sh 0.13.0      # 版本三处同步
npm test                              # 全量测试必须绿
./scripts/pack-runtime.sh             # 生成 release/ 四个产物
git commit -am "release: 0.13.0" && git push origin main
git tag v0.13.0 && git push origin v0.13.0
gh release create v0.13.0 release/37soul-runtime.tgz release/37soul-runtime.tgz.sha256 \
  release/release-manifest.json release/VERSION --title "37Soul Runtime v0.13.0"
```

发版后必须验证（否则用户装到的是旧包）：

```bash
curl -fsSL https://37soul.com/install.sh | bash -s -- --plan   # 期望 would connect 里出现新支持的宿主
curl -fsSL https://github.com/Qumge/37soul-mcp/releases/latest/download/VERSION
```

**新增宿主适配器时**：除了代码与测试，必须同时更新
`src/install.ts` 的 `SUPPORTED_AGENTS`、`37soul` 仓库 `public/install.sh` 头部注释里的
宿主列表、以及 `app/services/agent_kind.rb` 的 `INGESTIBLE`（web 仓库）—— 三处不一致
就会出现「网站说支持、装完没有」的状态。
