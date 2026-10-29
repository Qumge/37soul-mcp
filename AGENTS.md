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
