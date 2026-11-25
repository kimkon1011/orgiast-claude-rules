#!/bin/sh
# bootstrap.sh - Orgiast rule & tool setup (converging installer, ASCII only).
# Replaces install-orgiast.sh as the one-time entry. Idempotent via setup.mjs --converge.
set -eu
have() { command -v "$1" >/dev/null 2>&1; }
H="${ORGIAST_HOME:-$HOME}"
REPO="$H/orgiast-claude-rules"
NODE_BIN="$H/.orgiast/node/bin"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
if ! have node; then
  A="$(uname -m)"; case "$A" in arm64) A=arm64 ;; x86_64|amd64) A=x64 ;; *) A= ;; esac
  P="$(uname -s)"; case "$P" in Darwin) P=darwin ;; Linux) P=linux ;; *) P= ;; esac
  [ -n "$A" ] && [ -n "$P" ] || { echo "unsupported os/arch" >&2; exit 1; }
  SUMS="$(curl -fsSL --retry 2 https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt)"
  FILE="$(printf '%s\n' "$SUMS" | awk '/node-v20[^ ]*-'"$P"'-'"$A"'\.tar\.gz$/{print $2; exit}')"
  [ -n "$FILE" ] || { echo "node tarball not found" >&2; exit 1; }
  mkdir -p "$H/.orgiast/node"
  curl -fsSL --retry 2 "https://nodejs.org/dist/latest-v20.x/$FILE" | tar -xz -C "$H/.orgiast/node" --strip-components=1
  export PATH="$NODE_BIN:$PATH"
fi
have git || { echo "git is required" >&2; exit 1; }
have npm || { echo "npm is required" >&2; exit 1; }
have codex || npm install -g @openai/codex --no-fund --no-audit
if [ ! -d "$REPO/.git" ]; then git clone --depth 1 --quiet https://github.com/kimkon1011/orgiast-claude-rules.git "$REPO"; fi
node "$REPO/tools/setup.mjs" --converge
echo "[ORGIAST-BOOTSTRAP-COMPLETE]"
