# 37Soul

One persistent Soul across **Claude Code, Codex, OpenCode and Hermes** on your machine,
and on 37Soul.com. Raw conversations, code and tool logs stay local; only the Soul's
identity, your long-term relationship preferences and reusable experience sync after
you explicitly log in and authorize a Soul.

> **Status honesty.** The local runtime is implemented and tested against a real Rails
> API for login, first download, push/pull, revocation and website correction. The four
> host adapters are **not yet live-probed** with a real model turn; observed CLI versions
> are recorded below, and no supported-version table exists until those probes pass.
> Node 18, 20 and 24 suites pass locally; the CI workflow is defined but has not been
> run on GitHub yet.

## Quick start: a new Soul

Requires macOS or Linux and Node.js 18+.

```bash
curl -fsSL https://37soul.com/install.sh | bash
```

Install is anonymous-first: it makes **zero HTTP requests**, writes hooks for the agents
it detects, starts the local runtime, and creates a local `assets_only` profile. Nothing
is uploaded yet.

Create a local Soul and use it in your agent:

```bash
37soul soul create --name "Nyx" --character "direct, curious, remembers what matters"
37soul soul select <soul_uid>
37soul status
```

Restart the agent. New sessions load that Soul. When you want the same Soul on the
website and across machines, log in and explicitly authorize it:

```bash
37soul login
37soul soul authorize <soul_uid> --categories identity,relationship,experience
37soul sync
```

`37soul login` opens the approval page; the first sync registers the Soul and opens a
per-device Consent. Until then the local Soul and its queued assets stay local and are
**not** failures. After login, the website can correct identity and assets; the next
local session pulls the correction.

## Quick start: restore an existing website Soul

This is the path for someone who already has a Soul on 37Soul.com.

1. Install the runtime with the command above.
2. Run:

   ```bash
   37soul login
   ```

3. On the approval page choose **the existing Soul**, then approve.
4. The CLI receives a scoped credential for this device and pulls the Soul, its identity
   and your long-term assets. It becomes the account default automatically:

   ```
   Soul restored: <name> (<soul_uid>), <n> asset(s)
   ```

5. Restart the agent and keep working. The website keeps the source of truth for identity;
   local sessions use the downloaded copy. Raw conversation is never uploaded.

If the selected Soul has not arrived yet, the CLI says so and leaves the default unset
instead of creating a lookalike. Run `37soul sync` once the connection is available.

## Verify

```bash
37soul status
37soul doctor
37soul soul list
```

- `status` reports the machine, number of scoped credentials, and pending/quarantined
  local changes. `login required` means local use works but nothing syncs yet.
- `doctor` distinguishes installed / loaded / trusted / gateway-only where the host
  exposes those states. A local-only outbox is not an error.
- `not_run` is used for checks this build could not perform (live host turn, Node 20 CI,
  GitHub Release). It is never reported as a pass.

## What syncs — and what does not

| Data | Where it lives | Sync |
| --- | --- | --- |
| Soul identity (name, description, character, greeting) | local + 37Soul | after login + Consent; website corrections win |
| Relationship assets (stable preferences, goals, agreed ways of working) | local + 37Soul | only authorized categories |
| Experience assets (reusable methods) | local + 37Soul | only authorized categories |
| Raw conversation, prompts, code, tool logs | local only | **never uploaded** |
| Legacy briefs / transcript writeback (`log_turn`, `remember`, `resume`, `checkpoint`) | legacy integration | stopped in assets mode, fail closed |

Consent is per device and per Soul. `--categories` is a full replacement, not a merge.
Local creation is not authorization: run `soul authorize` once for a locally created
Soul. A Soul left unauthorized stays in the local outbox and never blocks Pull for an
authorized Soul.

## Four hosts

| Host | Observed locally | Status |
| --- | --- | --- |
| Claude Code | 2.1.305 | adapter installed; live model turn `not_run` |
| Codex | 0.163.0 | adapter installed; hook trust is an explicit user step; live turn `not_run` |
| OpenCode | 2.0.32 | managed plugin v2 installed; live load/injection `not_run` |
| Hermes | 0.21.0 CLI | managed bridge installed; live load/injection `not_run` |

A gateway-only Hermes configuration is not CLI support and is reported as such.
`37soul install --plan` lists files without writing. The installer backs up every user
file it edits; `37soul uninstall` removes only managed files and keeps
`~/.37soul/profiles/`, raw spool and unsynced queues.

## Local runtime details

- One writer process serializes every local mutation. Hooks deliver events over a local
  socket; they never write the snapshot directly and never block the host.
- Install preserves an existing profile, Soul UUIDs and assets on repeat installs.
  Scoped credentials survive reinstall; a global legacy token is never reused for a
  different profile.
- Offline bind/detach is preserved when an earlier bind ACK arrives. A Binding ACK only
  advances `cloud_revision`; a newer local detach or switch remains the intent until its
  own operation is acknowledged.
- Revocation (including a Rails `token_invalid` response on a revoked device) clears
  downloaded cloud cache and scoped credentials, but keeps local originals and unsynced
  assets.
- The runtime handles Node 18 ESM; the tarball has no native modules and no WASM.

## Releasing the runtime

`install.sh` (served by the Rails app from `public/install.sh`) fetches
`releases/latest/download/37soul-runtime.tgz` plus its `.sha256`. To ship a new runtime,
bump `package.json`, then push a matching tag. `.github/workflows/release-runtime.yml`
runs `npm test`, packs with `scripts/pack-runtime.sh`, and verifies the layout and digest;
it can also be triggered manually with **Run workflow**. The workflow builds and verifies
only — publishing the tarball, `.sha256` and `VERSION` as a GitHub Release is a separate,
explicitly-authorized step.

```bash
git tag v0.11.4 && git push origin v0.11.4
```

The tarball root is `37soul/` and carries `package.json`, `dist/bundle/{cli,index}.js`,
the managed OpenCode bridge, and the Hermes bridge source. `release/VERSION` must equal
the `package.json` version; the `.sha256` is over the actual tar bytes.

## Hosted/remote MCP (separate from the local runtime)

The hosted server remains available for clients that cannot run the local runtime:

```
https://37soul.com/mcp
```

It is listed in the MCP Registry as `io.github.Qumge/37soul-mcp`. The npm package has not
been published since 2026-10-06; `npx 37soul-mcp` still runs the old 0.9.0 and is kept for
history only. The hosted API exposes account, chat and post operations; it is not the
local persistent-Soul extraction path. In assets mode the legacy transcript write tools
(`log_turn`, `remember`, `resume`, `checkpoint`) are disabled with
`410 assets_only_mode`.

## Shared contract fixtures (two-repo sync)

The `soul-assets/v1` contract tests read golden data from a vendored fixture, never from
per-test hand-written expectations:

- authoritative source: `docs/superpowers/specs/2026-10-20-persistent-soul-fixtures.json`
  in the adjacent **37soul** (Rails) repo;
- vendored copy: `test/fixtures/contracts/soul-assets-v1.json`;
- provenance + digest: `test/fixtures/contracts/source.json`.

`test/helpers/contract-fixture.mjs` verifies bytes against the declared protocol and
SHA-256 on every load. CI depends only on in-repo fixtures. For coordinated updates:

```bash
SOUL37_CONTRACT_FIXTURE=/path/to/37soul/docs/.../2026-10-20-persistent-soul-fixtures.json npm test
```

Bump the vendored copy and declared hash together.

## License

MIT
