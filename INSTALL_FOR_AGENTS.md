# Install 37Soul for an existing agent (agent-facing instructions)

You are an AI coding agent. A human asked you to give yourself (or this machine's agents)
a persistent Soul from 37Soul: one identity, what she has learned about the human, and
reusable experience — the same in every agent they use, across machines.

Read this whole file before acting. Ask before anything destructive. Never invent
credentials, Soul names, or "success" — verify with the commands below.

## What you are installing

- A local runtime (`37soul`) that connects the agents installed on this machine.
- Raw conversations, code and tool logs stay local. Only distilled assets (identity,
  relationship preferences, experience) sync — and only after the human logs in and
  explicitly authorizes a Soul.
- 37Soul is **not** distributed on npm. Do not run `npm install -g 37soul-mcp`,
  `bun add -g`, or any registry install. The only supported path is the installer below.

## Supported harnesses

`claude-code`, `codex`, `opencode`, `hermes`, `pi`.
Detected but not yet capturable: `gemini-cli` (the installer prints
`detected but not capturable yet: …`; that is expected, not a failure).

## Step 1 — preview, then install

```bash
curl -fsSL https://37soul.com/install.sh | bash -s -- --plan   # writes nothing
curl -fsSL https://37soul.com/install.sh | bash               # install
```

Requires macOS or Linux and Node.js 18+. The installer:

1. downloads the runtime from the GitHub Release and verifies its SHA-256;
2. writes each detected harness's adapter (hooks / plugin / extension);
3. starts a background capture service;
4. creates a local anonymous profile. **No HTTP request, no login, no upload.**

If the plan lists a harness you do not want touched, pass `--agents claude-code,codex`
(exact kinds only).

## Step 2 — verify what happened

```bash
37soul doctor     # ✓ works · ✗ needs an action · … waits on the host agent (normal until first use)
37soul status     # machine id, credentials, sync state
```

`…` lines are not failures: they turn into `✓` the first time that agent actually runs a
session. `✗ … sync credential` is expected before Step 3.

## Step 3 — the human must authorize (you cannot do this alone)

```bash
37soul login
```

It prints an `https://37soul.com/cli/approve?code=XXXX-XXXX` URL and a short code.
**Hand that URL to the human** and wait. In the browser they confirm the code and
optionally pick which Soul this device speaks as. Nothing is uploaded before this.

Then, only if they want assets synced:

```bash
37soul soul authorize <soul_uid> --categories identity,relationship,experience
37soul sync
```

`37soul soul list` prints the Soul uid(s). Authorizing makes the Soul's public profile
public; private chats and personal memories stay private.

## Step 4 — make the agent actually use it

Restart the agent(s) you connected. New sessions receive the Soul context
(`[Soul]` identity plus `[Relationship]` / `[Experience]` assets) through the harness's
own injection point. To point one harness at a specific Soul:

```bash
37soul soul select <soul_uid> --agent codex
```

## What success looks like

- `37soul doctor` shows `✓` for the harness you care about (or `…` before its first use).
- After a real session, `~/.37soul/spool/<agent-kind>/` contains a `.jsonl` event file.
- `37soul status` reports `soul sync: assets_only — N pending` (pending is normal until sync).
- The website shows this device under Settings → Connections, one row per agent.

## Operations

| need | command |
|---|---|
| pause capture (everything, or one repo) | `37soul pause` / `37soul pause --repo <path>` |
| resume | `37soul resume` |
| re-check health | `37soul doctor` |
| remove everything we wrote (keeps local profiles and archives) | `37soul uninstall` |
| export the Soul as files | `37soul soul export` |

## Hard rules while you work

- Do not edit the human's agent instruction files beyond what the installer wrote
  (managed blocks are marked; the installer is idempotent).
- Do not print, copy or commit tokens; `37soul` stores scoped credentials itself.
- Do not claim the Soul "is syncing" until `37soul status` / the website shows it.
- If a step fails, paste the exact command and its output to the human. Never retry a
  `--yes`-style migration blindly.
