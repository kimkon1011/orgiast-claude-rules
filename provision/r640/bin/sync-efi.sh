#!/usr/bin/env bash
set -euo pipefail
mountpoint -q /boot/efi
mountpoint -q /boot/efi-secondary
install -d /boot/efi/EFI/BOOT
install -m 644 /boot/efi/EFI/ubuntu/shimx64.efi /boot/efi/EFI/BOOT/BOOTX64.EFI
install -m 644 /boot/efi/EFI/ubuntu/grubx64.efi /boot/efi/EFI/BOOT/grubx64.efi
install -m 644 /boot/efi/EFI/ubuntu/grub.cfg /boot/efi/EFI/BOOT/grub.cfg
rsync -a --delete /boot/efi/ /boot/efi-secondary/
