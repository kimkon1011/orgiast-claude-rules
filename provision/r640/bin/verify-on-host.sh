#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ $EUID -eq 0 ]] || { echo 'root required' >&2; exit 1; }
install -d -m 700 /var/log/orgiast-provision
exec node "$root/bin/verify.mjs"
