#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
ulimit -c 0
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
csv='' site="$root/site.json" dry_run=false
flags=()
while (($#)); do
    case "$1" in
        --csv) csv=${2:?CSV required}; shift 2 ;;
        --site) site=${2:?site required}; shift 2 ;;
        --dry-run) dry_run=true; shift ;;
        --prune|--delete|--confirm-delete) flags+=("$1"); shift ;;
        *) echo 'Usage: provision.sh --csv FILE [--site FILE] [--dry-run] [--prune [--delete --confirm-delete]]' >&2; exit 2 ;;
    esac
done
[[ -n "$csv" ]] || { echo 'CSV required' >&2; exit 2; }
users=$(node "$root/bin/accounts.mjs" "$csv" "$site" "${flags[@]}" --count)
if "$dry_run"; then
    printf '%s\n' 'PLAN: packages, desktop/Mozc, pinned apps, keyserve, Guacamole/JDBC, managed users, firewall, verification, backup timer'
    printf 'OK: users=%s desktop=xfce guacamole=planned xrdp=planned\n' "$users"
    exit 0
fi
[[ $EUID -eq 0 ]] || { echo 'root required' >&2; exit 1; }
[[ -f /etc/os-release ]] || exit 1
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || { echo 'Ubuntu 24.04 required' >&2; exit 1; }
install -d -m 700 /var/log/orgiast-provision /root/provision /run/orgiast-provision
exec 9>/run/orgiast-provision/provision.lock
flock -n 9 || { echo 'provision already running' >&2; exit 1; }
step() {
    local name=$1
    shift
    printf 'START %s\n' "$name"
    # Subcommands return summaries only. Third-party stdout/stderr is captured in memory.
    if "$@" >"/var/log/orgiast-provision/$name.log" 2>&1; then
        printf 'PASS %s\n' "$name"
    else
        printf 'FAIL %s (see restricted step log)\n' "$name" >&2
        exit 1
    fi
}
step preflight node "$root/bin/configure.mjs" preflight "$site"
step packages node "$root/bin/configure.mjs" packages "$site"
step desktop node "$root/bin/configure.mjs" desktop "$site"
step apps node "$root/bin/configure.mjs" apps "$site"
step credentials node "$root/bin/configure.mjs" credentials "$site"
step guacamole node "$root/bin/configure.mjs" guacamole "$site"
step users node "$root/bin/accounts.mjs" "$csv" "$site" "${flags[@]}"
step security node "$root/bin/configure.mjs" security "$site"
step operations node "$root/bin/configure.mjs" operations "$site"
if [[ " ${flags[*]} " == *' --prune '* ]]; then
    step revoke node "$root/bin/configure.mjs" revoke "$site"
fi
systemctl start --no-block orgiast-r640-verify.service
printf 'OK: users=%s desktop=xfce guacamole=configured xrdp=configured; host verification pending\n' "$users"
