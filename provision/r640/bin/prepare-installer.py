#!/usr/bin/env python3
"""Installer early-command: fail closed before Curtin can erase any disk."""
import ipaddress
import json
import pathlib
import subprocess
import sys
import time
import yaml


def choose_nic(candidates):
    """First linked physical Ethernet in stable name order. No fixed OS NIC name."""
    linked = sorted((c for c in candidates if c['wired'] and c['carrier']), key=lambda c: c['name'])
    if not linked:
        raise ValueError('no linked physical Ethernet')
    return {'match': {'macaddress': linked[0]['mac']}, 'dhcp4': True, 'dhcp6': False}


def storage_config(config, site, disks):
    physical = [d for d in disks if d['type'] == 'disk' and not d.get('rm')]
    if site['storageMode'] == 'mdadm':
        selected = []
        for serial in site['diskSerials']:
            matches = [d for d in physical if (d.get('serial') or '').strip() == serial]
            if len(matches) != 1:
                raise ValueError('SSD serial missing or ambiguous')
            selected.append(matches[0])
        if any(d.get('rota') or d.get('tran') != 'sata' for d in selected):
            raise ValueError('expected nonrotational SATA disks')
    else:
        # Physical serials are verified by Redfish before array creation. Here only the
        # single PERC virtual disk is permitted, never an arbitrary/largest disk.
        selected = [d for d in physical if 'PERC' in (d.get('model') or '').upper() or 'DELL' in (d.get('vendor') or '').upper()]
        if len(physical) != 1 or len(selected) != 1:
            raise ValueError('expected exactly one PERC virtual disk')
    if any(d['size'] < site['minimumDiskGiB'] * 1024**3 for d in selected):
        raise ValueError('disk capacity below approved minimum')
    entries = [c for c in config if c['type'] == 'disk']
    if len(entries) != len(selected):
        raise ValueError('ISO storage variant mismatch')
    for entry, disk in zip(entries, selected):
        entry.pop('match', None)
        entry['path'] = disk['path']  # read back from exact inventory, not hard-coded
    return config


def prepare(config, site, disks, candidates):
    ai = config['autoinstall']
    ai['identity']['hostname'] = site['hostname'].split('.')[0]
    ai['ssh']['authorized-keys'] = [site['adminSshKey']]
    uplink = choose_nic(candidates)
    if site.get('staticAddress'):
        ipaddress.ip_interface(site['staticAddress'])
        ipaddress.ip_address(site['gateway'])
        for ip in site['dns']:
            ipaddress.ip_address(ip)
        uplink.update(dhcp4=False, addresses=[site['staticAddress']], routes=[{'to': 'default', 'via': site['gateway']}], nameservers={'addresses': site['dns']})
    ai['network'] = {'version': 2, 'renderer': 'networkd', 'ethernets': {'uplink': uplink}}
    ai['storage']['config'] = storage_config(ai['storage']['config'], site, disks)
    return config


def main():
    if 'orgiast.confirm-wipe=1' not in pathlib.Path('/proc/cmdline').read_text().split():
        raise ValueError('confirmation missing from prepared ISO boot arguments')
    if not pathlib.Path('/sys/firmware/efi').exists():
        raise ValueError('UEFI boot required')
    filename, sitefile = map(pathlib.Path, sys.argv[1:])
    site = json.loads(sitefile.read_text())
    candidates = []
    for _ in range(30):
        candidates = []
        for nic in sorted(pathlib.Path('/sys/class/net').iterdir()):
            wired = (nic / 'device').exists() and not (nic / 'wireless').exists() and (nic / 'type').read_text().strip() == '1'
            if not wired:
                continue
            subprocess.run(['ip', 'link', 'set', 'dev', nic.name, 'up'], check=True, capture_output=True)
            try:
                carrier = (nic / 'carrier').read_text().strip() == '1'
            except OSError:
                carrier = False
            candidates.append(dict(name=nic.name, wired=True, carrier=carrier, mac=(nic / 'address').read_text().strip()))
        if any(c['carrier'] for c in candidates):
            break
        time.sleep(1)
    disks = json.loads(subprocess.check_output(['lsblk', '--json', '--bytes', '--nodeps', '--output', 'PATH,TYPE,SERIAL,SIZE,ROTA,TRAN,RM,MODEL,VENDOR']))['blockdevices']
    result = prepare(yaml.safe_load(filename.read_text()), site, disks, candidates)
    filename.write_text(yaml.safe_dump(result, sort_keys=False))
    print('OK: installer inventory and network selected')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('FAIL: installer confirmation/inventory/network validation; no partitioning allowed', file=sys.stderr)
        sys.exit(1)
