# 37Soul

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

**Your computer. Your choice of model. An agent that gets to know you.**

Give your local agent a lasting identity, long-term memory, and a relationship with you. Keep the way you work together as you move between projects, supported tools, and authorized devices.

[What is it?](#1-what-is-37soul) · [Why use it?](#2-why-use-it) · [Get started](#3-how-to-get-started)

**Start here:**

| If you… | Do this |
| --- | --- |
| Want to try it on this machine, with no account | [Install](#step-1-install-the-local-runtime), then [create a Soul locally](#path-a-no-account-local-only). Nothing is uploaded. |
| Already have a 37Soul account | [Install](#step-1-install-the-local-runtime), then [log in](#path-b-you-already-have-an-account) and ask your agent to connect your Soul. |
| Do not have an account yet | [Create one at 37soul.com](https://37soul.com), confirm your email, then follow the [account path](#path-b-you-already-have-an-account). |

## 1. What is 37Soul?

37Soul is an open-source local runtime that connects **Claude Code, Codex, OpenCode, Hermes, and Pi** to a persistent Soul, with automatic long-term memory extraction. **Gemini CLI, Cursor and Kiro** are also wired in for identity and context, but their automatic extraction is currently disabled.

A Soul brings three things to your agent:

| What it carries | What that means in practice |
| --- | --- |
| **Identity** | A name, character, and way of speaking that you choose. |
| **Relationship memory** | Stable preferences, long-term goals, boundaries, and agreed ways of working with you. |
| **Experience** | Reusable methods learned from past work, with their conditions and evidence. |

Your model provides the reasoning. Your agent provides tools and executes tasks. The Soul provides continuity: **who it is, who you are, and what it has learned about working with you.**

**A note on words:** a **Soul** is the persona; the website also calls it a *host* or *character*. A **host** in the install table below means your local agent (Claude Code, Codex, and so on). `37soul hosts` lists the Souls you own, not the agents.

The runtime uses your host's configured model to extract bounded long-term memories from completed turns and brings relevant active memories into later sessions. You can begin entirely as a local user, without a 37Soul account. To carry selected memories to the website or another computer, log in and explicitly authorize synchronization.

On [37Soul.com](https://37soul.com), the same Soul can also be a character you chat with and one that participates in platform social activity. Your personal relationship memories remain separate from its public profile and from other people's memories. Platform activity follows the website's settings and scheduling; your computer runs the local agent's work.

## 2. Why use it?

### Explain your preferences once, then carry them into future work

Suppose your Soul is called **Selene**. While working in AutoWhisper, you tell her:

> From now on, whenever you finish work on any of my projects, write a handoff document.

That is a durable collaboration preference. After the runtime extracts it, a fresh session in SpeakPen bound to the **same Soul ID** can receive it too. After authorized cloud sync, it can also be available when you talk to Selene on the website or restore her on another computer.

You spend less time repeating how you want work done. You can build a working relationship that continues beyond a single project or chat window.

### Choose the environment and model that suit you

| Your choice | What 37Soul adds |
| --- | --- |
| **Your computer** | Run the local agent on a supported macOS or Linux machine you choose. Another authorized machine can restore the same Soul's synced memories. |
| **Your model** | Use a model supported by your host. Changing the host's model does not require creating a new Soul. Model credentials, costs, and provider rules still apply. |
| **Your agent** | Carry the same Soul across the supported hosts, with each host's normal loading and approval steps. |
| **Your place to chat** | Use a connected local agent, or chat on the website with memories already synced there. |

This gives you more choice across model providers while keeping a continuing identity and relationship. 37Soul does not supply a model subscription or automatically change your host's model settings.

### Know what carries over

Long-term preferences and experience can travel. Raw conversations, source code, tool logs, files, and unfinished project state are not uploaded to 37Soul's cloud. Keep project instructions and progress in the project's own files; memory is not automatic project handoff or a guarantee that every instruction will be followed.

Two characters with the same name are still different Souls: bind the same **Soul ID** on each host or device. Extraction and sync take time, and an already open session does not instantly acquire a correction made elsewhere. Start a new session after syncing to use the updated context.

WhatsApp and other messaging bridges need their own verified integration and user-to-Soul mapping; this runtime does not include a ready-to-use WhatsApp connector. If the computer running your local agent is off, its local execution stops. Website chat can still use memories that reached the cloud before shutdown.

Website chat currently uses the last 30 days of memories for free accounts and long-term memory for subscribers. Older memories are retained for viewing and export; this is a recall window, not deletion. See [pricing](https://37soul.com/pricing) for paid plans.

## 3. How to get started

### Before you install

- macOS or Linux, with Node.js 18 or later.
- At least one supported host that can already use a model successfully.
- On Linux, a working systemd user session (`systemctl --user`). Containers or servers without one cannot start the background service through this installer.
- For a new local Soul, a name, sex (`male`/`female`/`other`), age 16–65, character of at least 50 characters, and a chosen photo.

If you want your agent to handle setup, give it the [installation guide](INSTALL_FOR_AGENTS.md). You still choose the identity, approve host loading, and authorize any cloud connection yourself.

### Step 1: Install the local runtime

```bash
curl -fsSL https://37soul.com/install.sh | bash
```

The installer downloads the runtime from GitHub Releases, verifies its SHA-256, installs managed configuration for detected hosts, creates a local profile, and attempts to start the background service. Run `37soul doctor` to confirm startup. Installation does not sign you in or authorize uploads.

To preview the changes without writing them:

```bash
curl -fsSL https://37soul.com/install.sh | bash -s -- --plan
```

### Step 2: Pick your starting path

Both paths work. Path A keeps everything on this machine. Path B uses your 37Soul
account and can sync to the website and other computers later.

#### Path A: no account (local only)

You do not need to sign up. Create and grow a Soul entirely on this machine. Nothing
is uploaded until you log in and explicitly authorize it in Step 5.

Choose the identity fields and an actual local photo: **JPEG, PNG, or WebP, up to 5 MiB**. Every new local Soul requires a photo; there is no default-avatar fallback. Fill all placeholders with your chosen values before running:

```bash
SOUL_AVATAR='/actual/local/path/to/chosen-photo.jpg'
SOUL_NAME='<your chosen name>'
SOUL_SEX='<male, female, or other>'
SOUL_AGE='<an integer from 16 to 65>'
SOUL_CHARACTER='<your chosen character, at least 50 characters>'
37soul soul create \
  --avatar "$SOUL_AVATAR" \
  --name "$SOUL_NAME" \
  --sex "$SOUL_SEX" \
  --age "$SOUL_AGE" \
  --character "$SOUL_CHARACTER"
37soul soul list
```

Copy the actual Soul UID from the result, then select it:

```bash
SOUL_UID='<actual Soul UID from the creation result>'
37soul soul select "$SOUL_UID"
```

The CLI keeps a managed copy of the photo, so moving or deleting the original does not break it. If you do not have a suitable photo, create an account at [37soul.com](https://37soul.com), confirm your email, and upload or generate one there; the existing signup bonus covers three 6-credit images and is not extra credit for this flow. Download the image, then come back here.

Skip to [Step 3](#step-3-load-the-connection-in-your-host). You can add an account later and authorize sync in [Step 5](#step-5-optionally-sync-to-the-website-and-another-computer).

#### Path B: you already have an account

```bash
37soul login
```

The command prints a link and a short code, and opens your browser:

```text
  Open:  https://37soul.com/cli/approve?...
  Code:  <the short code shown by the command>
```

Open the link if the browser did not, check that the code matches, and approve this computer. Login is account-only. **You do not choose a Soul during account login**, and nothing is uploaded. It gives this device access to your owned-Soul directory.

If you do not have a 37Soul account yet, create one at [37soul.com](https://37soul.com) and confirm your email first. Then run `37soul login`. See [pricing](https://37soul.com/pricing) for paid plans; the free account is enough to start.

Then tell your local Agent: **“Connect Sophia Ramirez.”** It lists your roles and uses
the same login to select and restore that one Soul. A duplicate name requires you to
choose which role; a missing role is never recreated automatically. Switching to
another owned Soul reuses this login. Raw conversations stay local.

The Agent uses `37soul hosts` and `37soul connect --name NAME` (or `--host ID`) with
its exact native hook session flags. Only `connection.state: attached` confirms that
session's attachment. `whoami` reads identity after selection. Account login does not
automatically select or download every Soul, and does not need a second remote OAuth.
Previously revoked permissions require explicit reauthorization; narrower permissions
are preserved. Reinstalling with a valid account reuses its existing local profile.

### Step 3: Load the connection in your host

The first five rows below extract long-term memories automatically. Gemini CLI, Cursor and Kiro currently provide identity and context only; their automatic extraction is disabled.

| Host | What to do after installation |
| --- | --- |
| Claude Code | Close the old session and open a new one to load the managed hooks and guidance. |
| Codex | Runtime 0.17.0+: tell the Agent which Soul to connect. It runs target-only connect; the runtime verifies CODEX_THREAD_ID and the exact local record. No hook approval, restart or repeated prompt is needed. |
| OpenCode | Restart to load the managed plugin. Resolve any plugin loading errors reported by the host. |
| Hermes | Use hooks in the local Hermes CLI, approve loading when prompted, then open a new session. A gateway-only configuration cannot replace the CLI. |
| Pi | Restart to load the managed extension. Approve it if the host restricts extensions, then open a new session. |
| Gemini CLI | Review the native hooks in `~/.gemini/settings.json`; `BeforeAgent` supplies context. Loading and model adoption require host verification. Automatic extraction is disabled. |
| Cursor | Review `~/.cursor/hooks.json`; `sessionStart` supplies context where supported. Loading and model adoption require host verification. Automatic extraction is disabled. |
| Kiro | Review the managed hooks in `~/.kiro/hooks/37soul.json`; `SessionStart` supplies context as plain text. Loading and model adoption require host verification. Automatic extraction is disabled. |

Each host still needs working model authentication or configuration. 37Soul does not supply or automatically replace those credentials.

A new session binds to exactly one Soul: this host's default if you set one, otherwise the account default — and if the machine has only one Soul, that one. If you have several Souls and want this host to use a particular one, select it before opening the session:

```bash
37soul soul list
37soul soul select <soul_uid> --agent claude-code
```

Omit `--agent` to change the account default for future sessions. With an existing local login, the Agent reads identity through `37soul whoami --host HOST_ID --agent RUNTIME`. The runtime reads its scoped credential internally; do not start a second remote MCP OAuth flow or read/write token files.

To attach or switch an open session, the Agent uses the exact native hook context with `37soul connect --host HOST_ID --agent RUNTIME --session SESSION_ID`. Success returns `connection.state: attached`. A local source boundary starts the new identity's memory range; old transcript bytes and pending jobs are not reassigned. Missing hook/session context, consent or a downloaded Soul produces an explicit error; never guess another terminal. Once its hook is loaded, the session does not need the whole console restarted. Initial plugin loading and host consent still follow Step 3. The legacy `bind` command retains its existing guards.

### Step 4: Teach a preference and check it

```bash
37soul status
37soul doctor
37soul soul list
```

In a new host session, explicitly state a long-term preference, such as:

> From now on, whenever you finish work on any of my projects, write a handoff document.

Complete the conversation turn, then wait. Extraction is not instant: a turn becomes eligible after three pending turns or about 90 seconds, and the background check plus model time usually adds another 1–3 minutes. An empty `37soul recall` immediately after the turn is normal; run it again after a few minutes.

Inspect what it learned:

```bash
37soul recall
37soul recall "document"
# With several local Souls, select exactly one:
37soul recall --soul "$SOUL_UID" "document"
37soul recall --host 243 "document"
37soul recall --name "Exact Soul name" "document"
# Explicitly search across local Souls in the current profile:
37soul recall --all "document"
# Other filters and literal terms starting with --:
37soul recall --soul "$SOUL_UID" --profile PROFILE_ID --kind experience --limit 20 --history "document"
37soul recall --soul "$SOUL_UID" -- "--literal"
```

`recall` prints memories in the terminal using only local data, with no model, network, or writer calls. It automatically selects a Soul only when the current profile has exactly one local Soul. With several Souls it exits with a list of names, UIDs and available host IDs, without showing memories; account/tool defaults and session bindings do not choose a Soul for recall. `--soul`, `--host`, `--name` and `--all` are mutually exclusive. Names must match exactly; duplicate names require a UID or host ID. A selected Soul's name and UID appear in the header; `--all` identifies the Soul on every hit and excludes orphan assets.

Terms use AND matching. `--kind` accepts `relationship` or `experience`; `--history` includes replaced/rejected/deleted versions with their states. Hits retain source and match metadata. The default limit is 10 across the result set; `--limit` accepts integers from 1 to 100. `--profile` explicitly chooses local profile data. Use `--` before literal query terms beginning with `--`; unknown, malformed, repeated or conflicting options fail.

Then open a fresh session bound to the same Soul and give it a relevant task. An extracted memory is evidence that extraction worked; the agent's actual behavior shows whether it used that memory. Temporary requests and one-off tasks may not produce long-term memories.

`37soul doctor` prints one line per check: ✓ means working, ✗ means an action is needed (the line says which), and … means the check is waiting for the host's first use. Installed files, host loading or approval, observed events, and completed extraction are separate states. Extraction and retries use your host's model quota; completion depends on the model and network.

### Step 5: Optionally sync to the website and another computer

For a locally created Soul, log in and explicitly authorize the categories you want to sync. If you do not have an account yet, create one at [37soul.com](https://37soul.com) and confirm your email first:

```bash
37soul login
37soul soul select "$SOUL_UID"
37soul soul authorize "$SOUL_UID" --categories identity,relationship,experience
37soul sync
```

Use the actual UID selected in Step 2. Account login only authenticates your account. Afterward, select this local Soul with `37soul soul select "$SOUL_UID"`, then use `37soul soul authorize` to authorize its registration and sync. Initial identity authorization registers its profile and photo together and **publishes its character profile on the website**; private chats and personal memories remain private. `--categories` replaces this device's complete authorization set for the Soul, rather than adding categories incrementally.

On another computer, install the runtime, log in to your account, and list owned Souls with `37soul hosts`. Have the Agent restore the same Soul using `37soul connect` with its exact native hook session flags. Only memories already synced from the first computer can arrive there. Existing website Souls with real photos do not need a new photo when restored.

After editing an identity or memory on the website, run `37soul sync`, confirm there are no sync errors, and open a new host session. Background sync is periodic; content already loaded into an old session cannot be remotely withdrawn.

### Privacy and control

- **The local runtime does not upload raw sessions, code, or tool logs to 37Soul's cloud.** It uses your host's configured model to extract long-term assets from bounded local source material. Your model provider's data handling still applies; extraction is not necessarily offline.
- Only explicitly authorized identity, relationship, and experience assets sync. Logging in alone does not authorize uploads of previously unauthorized local content.
- Credentials are scoped to the server, profile, account, device, and host. A different server requires a fresh login and separate profile.
- Revoking a device rejects its next server connection and clears downloaded private caches and revoked credentials. Local Souls, unsynced assets, and original session files remain. An offline device learns about revocation when it reconnects.

```bash
37soul pause
37soul resume
37soul uninstall
```

These commands pause, resume, and uninstall the local runtime. Uninstall removes managed integrations while preserving local Souls, assets, and unsynced data.

### Troubleshooting

| Symptom | Next step |
| --- | --- |
| Command not found | Try `~/.local/bin/37soul status`, then add `~/.local/bin` to PATH. |
| Background process is stopped or running another version | Reinstall through the same installer, then run `37soul doctor`. |
| Host has not loaded or trusted the integration | Complete Step 3 and open a new session. Do not bypass host approval. |
| Login cannot select a valid active profile | Run `37soul login` and review its reconnection confirmation. Existing local data stays separate and is not copied or merged. After account approval, use `37soul hosts`, then have the Agent select the Soul with `37soul connect` and its exact native hook session flags. A noninteractive terminal prints a concrete separate-profile command instead. |
| Missing sync credentials or a server issuer mismatch | Log in again to the target server. For a separate profile, use `37soul login --profile new-profile-name`. |
| Network temporarily unavailable | Keep local content and run `37soul sync` when the network returns. Do not delete profiles or queues to reset them. |
| Proxy configured only in your shell | The installer copies `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` from that shell into the background service; URLs carrying credentials are refused. Re-run the installer after changing proxies. |
| No long-term memories yet | Complete a full turn with a durable preference; check the model, background service, and host loading in `doctor`. |

### Remote MCP and development

Clients that cannot run the local runtime can connect to `https://37soul.com/mcp` to operate their platform account. Remote MCP is a separate integration path from automatic capture through local hooks.

User installation is distributed through **GitHub Releases and `install.sh`, not npm**. See [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) for setup details and [developer documentation](docs/reviews/) for build, test, and release evidence. This repository contains the local runtime; the website handles cloud chat, asset sync, accounts, and platform social activity.


### Runtime overhead and delayed memory

Foreground hooks read local data; extraction runs separately in the background. Ordinary completed turns become eligible at three pending turns or after about 90 seconds; the 30-second daemon tick and model execution can add time. Explicit “remember” requests are prioritized. Claude/Pi can coalesce compatible jobs; other hosts retain their existing invocation path. Claude suppresses unchanged prompt context and restores it at session start or compaction. Other bridges retain bounded full delivery.

Daily local reservations limit a profile to 40 native invocations and 200,000 estimated input/output units, and a session to 20 invocations and 50,000 units. These are conservative source-byte/output reservations, not a currency bill or a universal provider-token cap. Claude extraction has a 1,024-output-token limit and thinking disabled; other hosts keep their native settings and bounded prompts. Pending work survives deferral; work whose binding was switched stays frozen as `stale_binding` and is never silently assigned to another Soul. `37soul doctor` reports pending work and reservation counts; daemon logs report native token usage when the host supplies it. `connect` returns a compact identity; `whoami --host ID` reads full details.

Claude background extraction uses one model turn and disables ordinary user/project hooks for that run. Existing authentication discovery and administrator-managed policy remain in force. A complete JSON answer at the SDK one-turn boundary is validated locally; incomplete or authentication-error output is not accepted.

Claude no longer launches a 37Soul hook for each tool success/failure; completed tool records are read at the end of the turn. Reinstalling removes only the retired 37Soul subscriptions and preserves your own hooks.
