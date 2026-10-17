#!/usr/bin/env bash
# Builds the self-contained runtime tarball that https://37soul.com/install.sh downloads.
#
# Layout inside the tarball (what installRuntime() expects as its source root):
#   37soul/package.json            (name + version only)
#   37soul/dist/bundle/cli.js      (esbuild, no external modules)
#   37soul/dist/bundle/index.js
#
# Asset names carry no version so `releases/latest/download/<name>` always resolves.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build >/dev/null
npm run bundle >/dev/null

version="$(node -p 'require("./package.json").version')"
out="release"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/37soul/dist/bundle" "$out"
cp dist/bundle/cli.js dist/bundle/index.js "$stage/37soul/dist/bundle/"
node -e 'const p=require("./package.json"); process.stdout.write(JSON.stringify({name:p.name,version:p.version,type:"module"},null,2)+"\n")' \
  > "$stage/37soul/package.json"

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
( cd "$out" && { command -v sha256sum >/dev/null && sha256sum 37soul-runtime.tgz || shasum -a 256 37soul-runtime.tgz; } > 37soul-runtime.tgz.sha256 )
echo "$version" > "$out/VERSION"
echo "packed $out/37soul-runtime.tgz ($version)"
