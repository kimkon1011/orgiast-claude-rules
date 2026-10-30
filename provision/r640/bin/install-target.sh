#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
install -d -m 700 /target/root/.claude /target/etc/orgiast-r640
install -d -m 755 /target/opt/orgiast-r640
cp -a /cdrom/orgiast/. /target/opt/orgiast-r640/
install -m 600 /cdrom/private/keyserve.env /target/root/.claude/keyserve.env
install -m 600 /cdrom/orgiast/site.json /target/etc/orgiast-r640/site.json
install -m 600 /cdrom/private/employees.csv /target/etc/orgiast-r640/employees.csv
cat > /target/etc/systemd/system/orgiast-r640-provision.service <<'UNIT'
[Unit]
Description=R640 initial provisioning
Wants=network-online.target
After=network-online.target
ConditionPathExists=!/var/lib/orgiast-r640-provisioned
[Service]
Type=oneshot
UMask=0077
LimitCORE=0
TimeoutStartSec=0
ExecStart=/bin/bash /opt/orgiast-r640/bin/provision.sh --csv /etc/orgiast-r640/employees.csv --site /etc/orgiast-r640/site.json
ExecStartPost=/usr/bin/touch /var/lib/orgiast-r640-provisioned
[Install]
WantedBy=multi-user.target
UNIT
curtin in-target --target=/target -- systemctl enable orgiast-r640-provision.service
if [[ -d /target/boot/efi-secondary ]]; then
    install -m 755 /cdrom/orgiast/bin/sync-efi.sh /target/etc/kernel/postinst.d/zz-orgiast-efi
    curtin in-target --target=/target -- bash /opt/orgiast-r640/bin/sync-efi.sh
fi
