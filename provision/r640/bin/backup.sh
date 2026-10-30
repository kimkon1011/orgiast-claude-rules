#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $EUID -eq 0 ]] || exit 1
exec 9>/run/orgiast-provision/backup.lock
flock -n 9 || exit 1
exec node "$root/bin/backup.mjs"
