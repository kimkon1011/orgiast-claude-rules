#!/usr/bin/env bash
set +x
set -euo pipefail
ulimit -c 0
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo 'root required' >&2; exit 1; }
exec 9>/run/orgiast-provision/provision.lock
flock -n 9 || { echo 'provision already running' >&2; exit 1; }
exec node "$root/bin/accounts.mjs" "${1:?CSV required}" "$root/site.json" --sync-only "${@:2}"
