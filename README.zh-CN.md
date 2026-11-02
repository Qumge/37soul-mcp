# 37Soul

[English](README.md) · **简体中文** · [日本語](README.ja.md)

给你的 Agent 一个持续的身份，以及能跨会话、跨工具携带的长期偏好和经验。

本地运行时连接 Claude Code、Codex、OpenCode、Hermes 和 Pi。Soul 可以先只在本机使用；登录并明确授权后，指定类别的长期资产才同步到 37Soul。

## 安装

准备 macOS 或 Linux、Node.js 18 或更新版本，以及至少一个已经可以正常使用模型的受支持宿主。Linux 还需要可用的 systemd 用户会话（`systemctl --user`）；不具备这个条件的容器或服务器不能按此方式启动后台服务。

```bash
curl -fsSL https://37soul.com/install.sh | bash
```

安装器下载并校验运行时，为检测到的宿主安装受管配置，配置并尝试启动后台服务，并创建本地档案；运行 `37soul doctor` 确认服务启动成功。安装会访问下载服务器，但不会因此登录账号或上传对话。先查看改动范围可运行：

```bash
curl -fsSL https://37soul.com/install.sh | bash -s -- --plan
```

## 已经在网站上有 Soul

```bash
37soul login
```

1. 打开终端显示的授权链接，登录自己的账号。
2. 核对短码，选择已有的 Soul，再批准设备。
3. 终端显示 `Soul restored:` 后，完成下面相应宿主的接入步骤，并开启新会话。

如果没有选择角色，登录不等于已经恢复某个 Soul。选择自己的 Soul 后重新执行 `37soul login`。

## 先在本机创建 Soul

请先让用户确认名字、性别（`male`/`female`/`other`）、年龄（16–65）、至少 50 字的人设和照片。变量必须填写用户确认的真实选择，不要编造人设；运行前把 `/path/to/photo.jpg` 换成实际本地文件路径：

每个新建的本地 Soul 都必须通过 `--avatar` 提供实际照片，不接受默认头像。支持 JPEG、PNG、WebP，最大 5 MiB。CLI 会复制到托管本地档案，因此移动或删除原文件不会破坏照片。

网站支持上传照片或生成 AI 照片。注册并确认邮箱后的既有奖励为 18 credits，可生成 3 张图片（每张 6 credits），不会额外发放奖励。完全离线不能消费云端 credits；没有图片时，先在网站注册、确认邮箱、生成并下载，再把实际本地文件传给 CLI。

云端可选：登录、明确授权 identity 后再同步；首次登记将资料和照片一起上传。已有真实照片的网站 Soul 通过 login 恢复，无需新照片。


```bash
SOUL_NAME='<confirmed name>'
SOUL_SEX='<confirmed male, female or other>'
SOUL_AGE='<confirmed integer 16–65>'
SOUL_CHARACTER='<confirmed character of at least 50 characters>'
37soul soul create \
  --avatar '/path/to/photo.jpg' \
  --name "$SOUL_NAME" \
  --sex "$SOUL_SEX" \
  --age "$SOUL_AGE" \
  --character "$SOUL_CHARACTER"
37soul soul list
```

复制创建结果中的 Soul UID，替换下面变量的内容：

```bash
SOUL_UID='在这里粘贴实际的 Soul UID'
37soul soul select "$SOUL_UID"
```

完成宿主接入步骤并开启新会话后，即可本地使用。需要同步到网站或另一台机器时：

```bash
37soul login
37soul soul select "$SOUL_UID"
37soul soul authorize "$SOUL_UID" --categories identity,relationship,experience
37soul sync
```

授权会让该 Soul 的角色资料发布到网站；私聊和个人记忆不会因此变成公开内容。`--categories` 替换这台设备对该 Soul 的完整授权集合，不是增量添加。

## 完成宿主接入

| 宿主 | 安装后需要做什么 |
| --- | --- |
| Claude Code | 关闭旧会话，开启新会话加载受管 hooks 和指引。 |
| Codex | 在 Codex 中打开 `/hooks`，查看并批准 37Soul 的 hook，再开启新会话。安装器不能代替你的批准。 |
| OpenCode | 重启 OpenCode，使受管插件被加载；确认宿主没有报告插件加载错误。 |
| Hermes | 使用本机 Hermes CLI 的 hooks 接入；按宿主提示批准加载，再开启新会话。只有 gateway 的配置不能代替 CLI。 |
| Pi | 重启 Pi，使受管扩展被发现并加载，再开启新会话；如宿主限制扩展，先在宿主中批准。 |

每个宿主仍须拥有可用的模型登录或配置。37Soul 不提供或自动替换你的宿主模型凭证。

## 确认它正在工作

```bash
37soul status
37soul doctor
37soul soul list
```

在一个新会话中，明确说出一个稳定的协作偏好，例如“以后给我实施建议时，先列可执行步骤，再解释原因”。运行时在完成轮后提取长期资产。临时请求、一次性任务并不一定应变成长久记忆。

```bash
37soul recall "协作"
```

本地使用无需同步。已完成登录并授权该 Soul 后，再运行 `37soul sync` 检查云端同步。

提取需要宿主模型处理，失败时可能自动重试并再次消耗该宿主的额度；完成时间也受模型和网络影响。`doctor` 的“已安装”“等待宿主加载”“已观察到本地事件”不是同一状态，按旁边提示处理，不要把文件写入当作宿主已加载。

网站修改身份或长期资产后，想立即在下一次会话使用修正结果，先执行：

```bash
37soul sync
```

确认没有同步错误，再开启新的宿主会话。后台会定期同步，但网站修改不会瞬间改写已经打开的会话；已进入旧会话上下文的内容也不能被远程收回。

## 数据与授权

- **本地运行时不会向 37Soul 云端上传原始会话、代码或工具日志。** 本地运行时读取限定范围的会话来源，使用宿主配置的模型提取长期资产；模型服务的数据处理遵循你所用宿主及模型提供方的设置，不等于全过程离线。
- 只有明确授权的身份、关系和经验资产才同步到 37Soul。未授权的本地内容不会因为登录就自动获得上传许可。
- 登录使用绑定到服务器、档案、账号、设备和宿主的凭证。更换服务器需要重新登录，并使用独立档案；不会自动合并两个服务器上同编号的账号。
- 在网站撤销设备后，再次连接服务器会拒绝该设备并清理下载的私密缓存。本地创建的 Soul、未同步资产和原始会话文件保留；已经确认同步的资产副本会被清理。离线设备无法立即获知服务器刚发生的变更。

## 遇到问题

| 现象 | 下一步 |
| --- | --- |
| 命令找不到 | 先用 `~/.local/bin/37soul status`，并把 `~/.local/bin` 加入 PATH。 |
| 后台进程没有运行，或运行的是另一版本 | 重新运行安装命令，再执行 `37soul doctor`。 |
| 宿主未加载或未信任 | 完成上表中的宿主操作，再开新会话。不要用绕过批准的启动参数。 |
| 没有同步凭证，或提示服务器归属不匹配 | 在目标服务器重新登录；已有云档案不允许跨服务器复用。需要独立档案时使用 `37soul login --profile 新档案名`。 |
| 网络暂时不可用 | 本地内容保留，恢复网络后运行 `37soul sync`。不要删除档案或队列来“重置”。 |
| 尚未出现长期资产 | 确认有完整会话轮、宿主模型可用、后台运行；一次性内容可能不会产生长期资产。 |

```bash
37soul pause
37soul resume
37soul uninstall
```

上述命令分别用于暂停、恢复和卸载本地运行时。卸载删除受管集成，保留本地 Soul、资产与未同步数据。

## 远程 MCP

不能运行本地运行时的客户端，可以连接 `https://37soul.com/mcp` 操作自己的平台账号。它与本地 hooks 的自动捕获不是同一条接入路径。

## 开发与分发

用户安装只通过 GitHub Release 和网站 `install.sh`，不通过 npm。构建、测试、版本与发布证据见 [开发文档](docs/reviews/)；发布检查不等于自动发布。
