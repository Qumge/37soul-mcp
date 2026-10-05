# Releasing

This package ships to **two** places:

| Channel | What it feeds | How it gets updated |
| --- | --- | --- |
| npm | `npx 37soul-mcp` — most installs | manually, from your laptop |
| Official MCP Registry | discovery in MCP clients / aggregators | automatically, by CI |

The registry listing was added at 0.4.4. Everything before that shipped to npm
only, so registry-based discovery could not find this server at all. The sibling
`autowhisper-mcp` shows the other failure mode: it *was* listed, but sat on 0.1.0
while npm reached 0.1.4, because the two publishes were independent manual steps.
`.github/workflows/sync-mcp-registry.yml` now keeps this one honest.

## Steps

1. **Bump the version.** It lives in `package.json`, the `MCP_VERSION` constant in
   `src/index.ts`, and twice in `server.json`. The script does all of them and
   fails rather than leave a half-bumped tree:
   ```sh
   ./scripts/bump-version.sh 0.4.5
   ```

2. **Test.**
   ```sh
   npm test    # tsc, then test/smoke.mjs
   ```

3. **Publish to npm.** `cd` here first — `npm publish --prefix` does *not* work,
   it packages the current working directory instead. Expect
   `37soul-mcp@<version>` and `total files: 5` — confirm `dist/soul.js` is in the
   list; if it's missing, the build didn't run and you're about to publish a
   server that can't hold any persona state.
   ```sh
   npm publish --access public
   ```

4. **Commit and push.** The push triggers the registry sync, which reads npm's
   `latest` and publishes a matching registry version. Nothing to run by hand.

   ```sh
   git commit -am "release: 0.9.0" && git push origin main
   ```

5. **Confirm both agree** (CI already does this and fails loudly if not):
   ```sh
   npm view 37soul-mcp version
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=37soul" \
     | jq -r '[.servers[]
               | select(._meta["io.modelcontextprotocol.registry/official"].isLatest == true)
               | .server.version][0]'
   ```

## Things that will bite you

- **`mcpName` in `package.json` is the registry's ownership proof.** It must be
  present in the *published* tarball and must equal `name` in `server.json`
  (`io.github.Qumge/37soul-mcp`). Remove it and the registry stops accepting
  publishes for this package.
- **npm publish order matters.** The registry verifies against the package already
  on npm, so npm goes first. Push second — if you push while `server.json` is
  ahead of npm, CI fails on purpose rather than point the registry at a version
  nobody can install.
- **`description` in `server.json` is capped at 100 characters.** The live
  validator rejects longer, and `mcp-publisher init` happily prefills a longer one
  from `package.json`. Run `mcp-publisher validate` — it checks against the live
  schema, which has migrated before (now camelCase: `registryType`,
  `environmentVariables`, `isRequired`, `isSecret`). Don't guess it locally.
- **`mcp-publisher` via Homebrew is unreliable** — its bottle download has failed
  repeatedly. Grab the binary directly:
  ```sh
  gh release download v1.8.0 --repo modelcontextprotocol/registry --pattern "*darwin_arm64*"
  ```
- **npm 2FA**: this account uses a passkey and npm removed the TOTP option, so
  `--otp` has no code to give. Publishing goes through the browser auth flow the
  CLI offers.

**Verify the CI plumbing any time** without publishing (downloads the publisher,
validates against the live schema, performs the OIDC login, then stops):

```sh
gh workflow run "Sync MCP Registry" -f dry_run=true
```

## The remote endpoint (0.9.0+)

`server.json` also declares a `remotes` entry for `https://37soul.com/mcp`, so
clients that can take a URL can connect without installing anything.

Two things must travel **together**, or the registry will silently publish nothing:

- The registry sync only acts when npm's `latest` differs from the registry's —
  editing `server.json` without bumping the version just reports "In sync".
- `Authorization` on that `remotes` entry must stay `isRequired: false`. Setting
  it to `true` tells clients this server has no OAuth, and they will ask for a
  token instead of signing in.

`McpController::SERVER_VERSION` in the **Rails repo** (`37soul`) reports the same
version over MCP. `scripts/bump-version.sh` cannot reach it — bump it by hand in
the same release, or the two ends advertise different versions of the same tools.

## Release order for the remote endpoint (do not reorder)

The `remotes` entry points at `https://37soul.com/mcp`, so that endpoint has to
exist before anything announces it. This order is the only one that never points
a client at a 404:

1. **Rails merges and deploys** (`37soul`, branch `feat/mcp-remote-endpoint`).
   `POST /mcp` + the OAuth discovery documents go live. Then run the real-client
   checks in the handoff doc (§6) — Claude.ai connector, ChatGPT developer mode,
   Cloudflare, the three sign-in round trips.
2. **`npm publish 0.9.0`** (this repo, branch `feat/remote-endpoint-release`).
   The registry sync only fires when npm's `latest` changes, so this step is what
   actually publishes the `remotes` entry.
3. **Push `37soul-mcp` to `main`.** That is what triggers the registry sync.
4. **Push `37soul-skill` to `main` last** (`docs/remote-endpoint` branch). The
   `/skill` page reads GitHub `main` live — pushing it *is* deploying it, and it
   now tells agents to use the URL.
