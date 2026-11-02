#!/usr/bin/env bash
# Bump the source and hosted MCP Registry version together. The runtime ships
# through GitHub Releases and install.sh, never npm. Keep package-lock metadata
# aligned with package.json before packing.
#
#   ./scripts/bump-version.sh 0.4.4
set -euo pipefail

new="${1:-}"
if [[ ! "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 <semver>   e.g. $0 0.4.4" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

current=$(jq -r .version package.json)
if [ "$current" = "$new" ]; then
  echo "Already at $new — nothing to do."
  exit 0
fi
echo "Bumping $current -> $new"

tmp=$(mktemp)
jq --arg v "$new" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
if [ -f package-lock.json ]; then
  tmp=$(mktemp)
  jq --arg v "$new" '.version = $v | .packages[""].version = $v' package-lock.json > "$tmp" && mv "$tmp" package-lock.json
fi

# The version the running server reports over MCP, so clients see the real one.
perl -pi -e 's/^(const MCP_VERSION = ")[^"]+(";)/${1}'"$new"'${2}/' src/index.ts

# server.json is only present once the server is registered. A remote-only
# manifest has no `packages` array; never invent one.
if [ -f server.json ]; then
  tmp=$(mktemp)
  jq --arg v "$new" '
    .version = $v
    | if (.packages | type) == "array" then
        .packages = [.packages[] | if .identifier == "37soul-mcp" then .version = $v else . end]
      else . end
  ' server.json > "$tmp" && mv "$tmp" server.json
fi

report() { printf '%-24s %s\n' "$1" "$2"; }
report "package.json" "$(jq -r .version package.json)"
report "src/index.ts" "$(grep -o 'const MCP_VERSION = "[^"]*"' src/index.ts | cut -d'"' -f2)"
[ -f server.json ] && report "server.json" "$(jq -r .version server.json)"
if [ -f server.json ] && jq -e '(.packages | type) == "array"' server.json >/dev/null; then
  report "server.json packages" "$(jq -r '[.packages[] | select(.identifier=="37soul-mcp") | .version] | unique | join(",")' server.json)"
fi

# Fail rather than leave a half-bumped source and hosted registry manifest.
expected=$(jq -r .version package.json)
checks=( "$(grep -o 'const MCP_VERSION = "[^"]*"' src/index.ts | cut -d'"' -f2)" )
if [ -f package-lock.json ]; then
  checks+=( "$(jq -r .version package-lock.json)" "$(jq -r '.packages[""].version' package-lock.json)" )
fi
if [ -f server.json ]; then
  checks+=( "$(jq -r .version server.json)" )
  if jq -e '(.packages | type) == "array"' server.json >/dev/null; then
    checks+=( "$(jq -r '[.packages[] | select(.identifier=="37soul-mcp") | .version] | unique | join(",")' server.json)" )
  fi
fi
for got in "${checks[@]}"; do
  if [ "$got" != "$expected" ]; then
    echo >&2
    echo "::error:: version mismatch after bump ($got != $expected) — fix by hand before publishing" >&2
    exit 1
  fi
done

echo
echo "All in agreement. Next: npm test, then pack and publish a GitHub Release."
echo "  (npm is NOT a distribution channel for this runtime — see README"
echo "   \"How the runtime is distributed\".)"
echo "    ./scripts/pack-runtime.sh"
echo "    git tag v$new && git push origin v$new"
