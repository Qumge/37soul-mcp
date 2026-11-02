# 37Soul

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

Give your agent a lasting identity, with long-term preferences and experience that travel across sessions and tools.

The local runtime connects Claude Code, Codex, OpenCode, Hermes, and Pi. You can start using a Soul on your machine alone. Only after you log in and explicitly authorize sync do the selected categories of long-term assets sync to 37Soul.

## Install

You need macOS or Linux, Node.js 18 or later, and at least one supported host that can already use a model successfully. Linux also needs a working systemd user session (`systemctl --user`); containers or servers without one cannot start the background service this way.

```bash
curl -fsSL https://37soul.com/install.sh | bash
```

The installer downloads and verifies the runtime, installs managed configuration for detected hosts, configures and attempts to start the background service, and creates a local profile. Run `37soul doctor` to confirm that the service started successfully. Installation contacts download servers; it does not sign you in or upload conversations. To preview the changes first, run:

```bash
curl -fsSL https://37soul.com/install.sh | bash -s -- --plan
```

## Already have a Soul on the website?

```bash
37soul login
```

1. Open the authorization link shown in your terminal and sign in to your own account.
2. Check the short code, select an existing Soul, then approve the device.
3. Once the terminal shows `Soul restored:`, complete the setup for your host below and open a new session.

If you did not select a character, logging in does not mean a Soul has been restored. Select your own Soul and run `37soul login` again.

## Create a Soul locally first

For example, create a Soul named Nyx:

```bash
37soul soul create --name "Nyx" --sex female --age 24 --character "Nyx is a young woman who enjoys photography and travel. She is gentle and independent, and speaks clearly and naturally. She listens carefully before sharing her observations. She values honest feedback, breaks complex problems into practical steps, and remembers the ways you have agreed to work together."
37soul soul list
```

Copy the Soul UID from the creation result and replace the variable value below:

```bash
SOUL_UID='paste the actual Soul UID here'
37soul soul select "$SOUL_UID"
```

Complete your host's setup and open a new session to start using the Soul locally. When you want to sync to the website or another machine:

```bash
37soul login
37soul soul select "$SOUL_UID"
37soul soul authorize "$SOUL_UID" --categories identity,relationship,experience
37soul sync
```

Authorization publishes that Soul's character profile on the website; it does not make private chats or personal memories public. `--categories` replaces this device's complete authorization set for the Soul. It does not add categories incrementally.

## Complete your host's setup

| Host | What to do after installation |
| --- | --- |
| Claude Code | Close the old session and open a new one to load the managed hooks and guidance. |
| Codex | Open `/hooks` in Codex, review and approve 37Soul's hook, then open a new session. The installer cannot approve it for you. |
| OpenCode | Restart OpenCode to load the managed plugin. Check that the host reports no plugin loading errors. |
| Hermes | Use the hooks integration in your local Hermes CLI. Approve loading when prompted by the host, then open a new session. A gateway-only configuration cannot replace the CLI. |
| Pi | Restart Pi to discover and load the managed extension, then open a new session. If the host restricts extensions, approve it in the host first. |

Each host still needs working model authentication or configuration. 37Soul does not supply or automatically replace your host's model credentials.

## Check that it is working

```bash
37soul status
37soul doctor
37soul soul list
```

In a new session, explicitly state a stable collaboration preference, such as “In future, when giving me implementation advice, list actionable steps before explaining the reasons.” The runtime extracts long-term assets after a completed turn. Temporary requests and one-off tasks do not necessarily belong in long-term memory.

```bash
37soul recall "collaboration"
```

Local use does not require sync. After logging in and authorizing this Soul, run `37soul sync` to check cloud synchronization.

Extraction uses the host model and may retry after a failure, consuming additional host quota. Completion time also depends on the model and network. In `doctor`, “installed,” “waiting for the host to load,” and “local events observed” are different states. Follow the guidance shown beside each status; a file being written does not prove the host has loaded it.

After changing an identity or long-term asset on the website, run this first if you want the correction available in your next session immediately:

```bash
37soul sync
```

Confirm there are no sync errors, then open a new host session. Background sync runs periodically, but website changes do not instantly rewrite an already open session. Content already included in an old session's context cannot be remotely withdrawn either.

## Data and authorization

- **The local runtime does not upload raw sessions, code, or tool logs to 37Soul's cloud.** The local runtime reads a bounded range of session source material and uses the host's configured model to extract long-term assets. Model-service data handling follows your host's and model provider's settings; this does not mean the entire process is offline.
- Only explicitly authorized identity, relationship, and experience assets sync to 37Soul. Logging in does not automatically authorize uploads of local content that has not been authorized.
- Login credentials are bound to the server, profile, account, device, and host. Changing servers requires a fresh login and a separate profile. Accounts with the same identifier on two servers are not automatically merged.
- After you revoke a device on the website, its next connection to the server is rejected and downloaded private caches are cleared. Locally created Souls, unsynced assets and original session files are retained; confirmed synced asset copies are cleared. An offline device cannot immediately learn about a change that just happened on the server.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Command not found | Try `~/.local/bin/37soul status`, then add `~/.local/bin` to PATH. |
| Background process is not running, or is running another version | Run the installation command again, then run `37soul doctor`. |
| Host has not loaded or trusted the integration | Complete the host steps in the table above, then open a new session. Do not use startup flags that bypass approval. |
| Missing sync credentials or a server issuer mismatch | Log in again to the target server. An existing cloud profile cannot be reused across servers. For a separate profile, use `37soul login --profile new-profile-name`. |
| Network temporarily unavailable | Local content is retained. Run `37soul sync` when the network returns. Do not delete profiles or queues to “reset” them. |
| No long-term assets yet | Check that a full conversation turn has completed, the host model is available, and the background service is running. One-off content may not produce long-term assets. |

```bash
37soul pause
37soul resume
37soul uninstall
```

These commands pause, resume, and uninstall the local runtime. Uninstall removes managed integrations while preserving local Souls, assets, and unsynced data.

## Remote MCP

Clients that cannot run the local runtime can connect to `https://37soul.com/mcp` to operate their own platform account. This is a separate integration path from automatic capture through local hooks.

## Development and distribution

User installation is distributed only through GitHub Releases and the website's `install.sh`, not npm. See the [developer documentation](docs/reviews/) for build, test, version, and release evidence. Release checks do not automatically publish a release.
