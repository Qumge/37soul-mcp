#!/usr/bin/env bash
# 37Soul local installer.
#
#   curl -fsSL https://37soul.com/install.sh | bash
#   curl -fsSL https://37soul.com/install.sh | bash -s -- --plan     # show what it would change, write nothing
#
# Connects Claude Code, Codex, OpenCode, Hermes and Pi on this computer to your 37Soul
# Soul: the same identity and long-term assets across tools. Raw conversations, code
# and tool logs stay local; only distilled assets are synced.
#
# What it does:
#   1. checks for Node.js 18+
#   2. downloads the self-contained runtime from the 37soul-mcp GitHub release and
#      verifies its SHA-256 checksum
#   3. runs `37soul install`: local adapters for each detected tool, background runtime.
#      It is anonymous-first: no login, no HTTP request, no upload. To sync the Soul
#      to 37Soul later, run `37soul login` and approve the Soul in the browser.
#
# Undo everything with: 37soul uninstall
# Source: https://github.com/Qumge/37soul-mcp

# Everything lives inside main() so a truncated download can never run half a script.
main() {
  set -euo pipefail

  local release_base="${SOUL37_RELEASE_BASE:-https://github.com/Qumge/37soul-mcp/releases/latest/download}"
  local asset="37soul-runtime.tgz"

  say() { printf '%s\n' "$*"; }
  fail() { printf '37soul: %s\n' "$*" >&2; exit 1; }

  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) fail "only macOS and Linux are supported for now. On Windows, use WSL." ;;
  esac

  command -v curl >/dev/null 2>&1 || fail "curl is required."
  command -v tar >/dev/null 2>&1 || fail "tar is required."

  local node="${SOUL37_NODE:-}"
  if [ -z "$node" ]; then node="$(command -v node 2>/dev/null || true)"; fi
  if [ -z "$node" ] || [ ! -x "$node" ]; then
    fail "Node.js 18 or newer is required and was not found.
  Install it with one of:
    brew install node                 (macOS, Homebrew)
    https://nodejs.org/en/download    (installer)
    https://github.com/nvm-sh/nvm     (nvm)
  then run this command again."
  fi
  local major
  major="$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt 18 ] 2>/dev/null; then
    fail "Node.js 18 or newer is required (found $("$node" -v 2>/dev/null || echo unknown) at $node)."
  fi

  # Global on purpose: the EXIT trap runs after main() returns, when locals are gone.
  SOUL37_TMP="$(mktemp -d)"
  trap 'rm -rf "${SOUL37_TMP:-}"' EXIT
  local tmp="$SOUL37_TMP"

  say "Downloading the 37Soul runtime…"
  curl -fsSL "$release_base/$asset" -o "$tmp/$asset" || fail "could not download $release_base/$asset"
  curl -fsSL "$release_base/$asset.sha256" -o "$tmp/$asset.sha256" || fail "could not download the checksum"

  local expected actual
  expected="$(awk 'NR == 1 { print $1 }' "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
  else
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
  fi
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    fail "checksum mismatch for $asset — refusing to install."
  fi

  tar -xzf "$tmp/$asset" -C "$tmp"
  local cli="$tmp/37soul/dist/bundle/cli.js"
  [ -f "$cli" ] || fail "the downloaded runtime is incomplete."

  if [ "$#" -eq 0 ]; then set -- install; elif [ "${1#-}" != "$1" ]; then set -- install "$@"; fi

  # `curl | bash` gives this script the pipe as stdin; hand the installer the terminal instead.
  if [ -r /dev/tty ] && (exec </dev/tty) 2>/dev/null; then
    "$node" "$cli" "$@" </dev/tty
  else
    "$node" "$cli" "$@"
  fi

  if [ "$1" = "install" ] && [ "${2:-}" != "--plan" ]; then
    say ""
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) say "Done. Check any time with: 37soul doctor" ;;
      *) say "Done. Check any time with: ~/.local/bin/37soul doctor   (add ~/.local/bin to your PATH to type just 37soul)" ;;
    esac
    say "Restart the agents you connected to pick it up."
    say "To sync long-term Soul assets with 37Soul, run: 37soul login"
  fi
}

main "$@"
