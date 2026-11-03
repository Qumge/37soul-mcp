# Install 37Soul for an existing agent

Read this guide before acting. Use the human's choices, never invented credentials or a
persona. Raw conversations, code and tool logs stay local; only explicitly authorized
identity, relationship and experience assets sync to 37Soul. The host's configured model
processes bounded local source material, so extraction is not an entirely offline process.
37Soul is **not** distributed on npm. Use the GitHub Release installer below.

## Supported hosts and prerequisites

`claude-code`, `codex`, `opencode`, `hermes`, `pi`.
`gemini-cli` may be detected but is not capturable yet; report that limitation honestly.

- macOS or Linux, Node.js 18+, curl and tar.
- At least one supported host with working model authentication. 37Soul does not supply
  or replace the host's model credentials.
- Linux needs a working systemd user session (`systemctl --user`). Containers or servers
  without one cannot start this background service; stop and report the prerequisite.

## 1. Preview and install

```bash
curl -fsSL https://37soul.com/install.sh | bash -s -- --plan
curl -fsSL https://37soul.com/install.sh | bash
```

The plan writes nothing. Installation contacts download servers over HTTP(S), verifies
the Release SHA-256, writes managed host configuration and a local profile, and attempts
to start the background service. It does not automatically log in or sync. Run
`37soul doctor` to verify service startup, rather than assuming success.
To restrict host changes, pass `--agents claude-code,codex` after `bash -s --`.
If the command is not found, use `~/.local/bin/37soul` and add `~/.local/bin` to PATH.

## 2. Choose one starting path

### A. Create and use a Soul locally, without an account

Local use does not require login or sync. Ask the human to confirm the required
name, sex, age (16–65), and character (at least 50 characters). Sex must be `male`,
`female` or `other`. Do not invent a persona or execute unfilled placeholders.
Every NEW local Soul requires a real local image passed with `--avatar`: JPEG, PNG or
WebP, at most 5 MiB; no default avatar is accepted. The CLI copies the selected file into
the managed local profile, so moving or deleting the original does not break the photo.
On the website, upload your own photo or generate an AI photo. Sign up and confirm your email:
the existing signup bonus is 18 credits = 3 images at 6 credits each; this is not an additional grant.
Fully offline creation cannot spend cloud credits. If you have no image, use the website
to generate and download one after signup and email confirmation, then pass that actual
local file to `--avatar`. Ask the human to confirm the image and all profile choices.
Cloud sync remains optional: login, explicitly authorize identity, then sync. Initial
registration sends the profile and photo together. Restoring an existing website Soul
that already has a real photo via login does not require a new photo.

Fill these values only with the human's confirmed choices:

```bash
SOUL_AVATAR='/actual/local/path/to/chosen-photo.jpg'
SOUL_NAME='<confirmed name>'
SOUL_SEX='<confirmed male, female or other>'
SOUL_AGE='<confirmed integer from 16 to 65>'
SOUL_CHARACTER='<confirmed character of at least 50 characters>'
37soul soul create \
  --avatar "$SOUL_AVATAR" \
  --name "$SOUL_NAME" \
  --sex "$SOUL_SEX" \
  --age "$SOUL_AGE" \
  --character "$SOUL_CHARACTER"
37soul soul list
SOUL_UID='<actual Soul UID from the creation result>'
37soul soul select "$SOUL_UID"
```

Complete the host steps below and open a new session. Cloud setup is optional;
continue to section 4 only when the human requests it.

### B. Existing website Soul: login and restore

```bash
37soul login
```

Give the displayed approval URL and short code privately to the human. They sign in,
verify the code, select their existing Soul and approve the device. Selecting an existing
Soul grants the initial sync consent described by the approval page; review it before
approving. Wait for `Soul restored:` in the terminal. If no Soul was selected, login
alone does not restore one: repeat login and select the intended Soul. Do not create a
replacement persona. Complete the host steps and open a new session.

## 3. Complete normal host approval

Do not bypass host approval or fabricate trust records.

| Host | Required action |
| --- | --- |
| Claude Code | Close the old session and open a new one to load managed hooks and guidance. |
| Codex | Open `/hooks`, review and approve 37Soul's hook, then open a new session. The installer cannot approve it. |
| OpenCode | Restart to load the managed plugin; resolve any reported plugin loading error. |
| Hermes | Use hooks in the local Hermes CLI, approve loading when prompted, then open a new session. A gateway-only setup is not a substitute. |
| Pi | Restart to load the managed extension; approve it if the host restricts extensions, then open a new session. |

Each new session binds to one Soul: this host's default if set, otherwise the account
default, otherwise the only local Soul. If the human names a Soul, select it for this
host before the session opens:

```bash
37soul soul list
37soul soul select <soul_uid> --agent <kind>
```

Omit `--agent` to change the account default. Do not guess when several Souls exist and
the human did not say which one — ask. A session that has already started cannot switch
Souls in place: tell the human to open a new session after the selection.

## 4. Optional cloud sync and website corrections

For a locally created Soul, only after the human agrees to publication and sync:

```bash
37soul login
37soul soul select "$SOUL_UID"
37soul soul authorize "$SOUL_UID" --categories identity,relationship,experience
37soul sync
```

Use the actual UID of the local Soul. During browser approval, do not select a different
website Soul when the intent is to sync this local Soul.
Identity authorization registers the profile and photo together.
Authorization publishes the Soul's public character profile; private chats and personal
memories stay private. `--categories` replaces the complete authorization set for this
device and Soul, not an incremental addition. Confirm the full desired set with the
human before each authorization; choose only the categories they approve.

After a website correction, run `37soul sync`, confirm there are no sync errors, then
open a new session. Background sync is periodic: it does not rewrite an already open
session or withdraw content already loaded into its context.

## 5. Verify and report precisely

```bash
37soul status
37soul doctor
37soul soul list
37soul recall "collaboration"
```

Installed files do not prove host loading; local extraction does not prove cloud sync.
Distinguish service startup, host approval/loading, observed local events, extracted
assets and confirmed sync. Follow each doctor action; a waiting state is not a completed
host check. A full real conversation turn and a useful long-term preference may be
needed before an asset appears. Extraction and retries consume host model quota.
Only a logged-in, authorized device should be expected on the website's Connections page.
Remote MCP is a separate platform account integration, not local automatic capture.

If troubleshooting is needed, share only a sanitized command, status and error summary:
redact tokens, authorization codes, account identifiers, local paths and raw session content.
Never paste credentials, private source files or complete session/spool files. Do not
claim success from a fixture or repeat a model call without the human's authorization.

## Operations

`37soul pause`, `37soul resume`, `37soul doctor`, `37soul uninstall`.
Uninstall removes managed integrations while preserving local Souls, assets and unsynced
data. Do not delete profiles or queues as a troubleshooting shortcut, and do not edit
managed host blocks by hand. Reinstall through the same installer if the service is
missing or running an old version, then check doctor and normal host approval again.
