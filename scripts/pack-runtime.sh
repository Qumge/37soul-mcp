#!/usr/bin/env bash
# Builds the self-contained runtime tarball that https://37soul.com/install.sh downloads.
#
# Layout inside the tarball (what installRuntime() expects as its source root):
#   37soul/package.json                (name + version + "type":"module")
#   37soul/dist/bundle/cli.js          (esbuild, no external modules)
#   37soul/dist/bundle/index.js
#   37soul/dist/adapters/plugins/opencode.js   (managed OpenCode bridge bundle)
#   37soul/src/adapters/plugins/hermes.py      (managed Hermes bridge, stdlib only)
#
# The runtime is pure JS + one stdlib Python file: no native modules, no WASM.
# Asset names carry no version so `releases/latest/download/<name>` always resolves.
set -euo pipefail
cd "$(dirname "$0")/.."

repo_root="$(pwd -P)"

npm run build >/dev/null
npm run bundle >/dev/null

version="$(node -p 'require("./package.json").version')"
out="release"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Out-of-tree rejection: every artifact we ship must resolve inside this repo.
# `cp` of an absolute path that escapes the repo (or a symlink that resolves out)
# must fail the pack, not silently bundle someone else's file.
require_inside() {
  local f="$1"
  local resolved
  resolved="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)/$(basename "$f")"
  case "$resolved" in
    "$repo_root"/*) ;;
    *) echo "refusing to pack out-of-tree path: $f" >&2; exit 1 ;;
  esac
}

for artifact in \
  "dist/bundle/cli.js" \
  "dist/bundle/index.js" \
  "dist/adapters/plugins/opencode.js" \
  "src/adapters/plugins/hermes.py"; do
  require_inside "$artifact"
done

mkdir -p "$stage/37soul/dist/bundle" "$stage/37soul/dist/adapters/plugins" "$stage/37soul/src/adapters/plugins" "$out"
cp dist/bundle/cli.js dist/bundle/index.js "$stage/37soul/dist/bundle/"
cp dist/adapters/plugins/opencode.js "$stage/37soul/dist/adapters/plugins/opencode.js"
cp src/adapters/plugins/hermes.py "$stage/37soul/src/adapters/plugins/hermes.py"
node -e 'const p=require("./package.json"); process.stdout.write(JSON.stringify({name:p.name,version:p.version,type:"module"},null,2)+"\n")' \
  > "$stage/37soul/package.json"

# No native modules / WASM: the runtime ships only JS, JSON and the stdlib Python bridge.
odd_file="$(find "$stage/37soul" -type f ! -name '*.js' ! -name '*.json' ! -name '*.py' -print -quit)"
if [[ -n "$odd_file" ]]; then
  echo "non-JS/JSON/Python file in runtime (native module or WASM?): $odd_file" >&2
  exit 1
fi

# Smoke: the bundle must start without node_modules next to it.
smoke_home="$(mktemp -d)"
smoke_out="$(SOUL37_HOME="$smoke_home" node "$stage/37soul/dist/bundle/cli.js" status 2>&1 || true)"
if [[ "$smoke_out" != *"not installed"* ]]; then
  rm -rf "$smoke_home"
  echo "bundled cli.js does not start on its own" >&2
  exit 1
fi
rm -rf "$smoke_home"

tar -C "$stage" -czf "$out/37soul-runtime.tgz" 37soul

# VERSION is the package version (single source of truth); refuse a drift.
echo "$version" > "$out/VERSION"

# .sha256 holds the SHA-256 of the actual tar bytes and its filename matches the tarball.
( cd "$out" && { command -v sha256sum >/dev/null && sha256sum 37soul-runtime.tgz || shasum -a 256 37soul-runtime.tgz; } > 37soul-runtime.tgz.sha256 )
recorded="$(awk '{print $1}' "$out/37soul-runtime.tgz.sha256")"
actual="$({ command -v sha256sum >/dev/null && sha256sum "$out/37soul-runtime.tgz" || shasum -a 256 "$out/37soul-runtime.tgz"; } | awk '{print $1}')"
if [[ "$recorded" != "$actual" ]]; then
  echo ".sha256 does not match the tarball bytes" >&2
  exit 1
fi

# ReleaseManifest: delivery metadata only (version/protocol/node_min/files/sha256).
# Nothing in the runtime reads it to gate behaviour; it exists so an installer can
# verify what it downloaded without trusting the archive layout blindly.
node - "$version" <<'NODE' > "$out/release-manifest.json"
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const version = process.argv[2];
const files = execFileSync("tar", ["-tzf", "release/37soul-runtime.tgz"], { encoding: "utf8" })
  .split("\n")
  .filter((line) => line !== "" && !line.endsWith("/"))
  .map((line) => line.replace(/^37soul\//, ""))
  .sort();
const sha256 = fs.readFileSync("release/37soul-runtime.tgz.sha256", "utf8").trim().split(/\s+/)[0];
process.stdout.write(
  JSON.stringify({ version, protocol: "soul-assets/v1", node_min: "18", files, sha256 }, null, 2) + "\n",
);
NODE

echo "packed $out/37soul-runtime.tgz ($version)"
