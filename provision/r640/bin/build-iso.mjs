#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, run, atomic, readJson, parseCsv, validateSite } from '../lib/core.mjs';

async function sha256(file) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
let staging;
try {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--confirm-wipe') options.confirm = true;
    else if (['--iso', '--iso-sha256', '--site', '--csv', '--enrollment', '--output', '--url'].includes(key) && process.argv[i + 1]) options[key.slice(2)] = process.argv[++i];
    else throw new Error('invalid build arguments');
  }
  if (!options.confirm) throw new Error('confirmation required to prepare destructive media');
  const site = validateSite(readJson(options.site));
  parseCsv(fs.readFileSync(options.csv, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(options['iso-sha256'] ?? '') || await sha256(options.iso) !== options['iso-sha256']) throw new Error('official Ubuntu ISO SHA256 mismatch');
  if (fs.existsSync(options.output)) throw new Error('output exists');
  const url = new URL(options.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search) throw new Error('use HTTPS restricted artifact host');
  if (!/^ORGIAST_KEYSERVE_SECRET=.+$/m.test(fs.readFileSync(options.enrollment, 'utf8'))) throw new Error('host keyserve enrollment required');
  // Stay beside output: persistent workspace; restricted permissions, never /tmp public ISO.
  staging = fs.mkdtempSync(path.join(path.dirname(path.resolve(options.output)), '.r640-iso-'));
  fs.chmodSync(staging, 0o700);
  for (const dir of ['orgiast', 'nocloud', 'private']) fs.mkdirSync(path.join(staging, dir), { mode: 0o700 });
  for (const entry of ['bin', 'lib', 'compose.yaml', 'versions.env']) fs.cpSync(path.join(ROOT, entry), path.join(staging, 'orgiast', entry), { recursive: true });
  atomic(path.join(staging, 'orgiast/site.json'), JSON.stringify(site));
  atomic(path.join(staging, 'private/employees.csv'), fs.readFileSync(options.csv));
  atomic(path.join(staging, 'private/keyserve.env'), fs.readFileSync(options.enrollment));
  fs.copyFileSync(path.join(ROOT, 'autoinstall', site.storageMode === 'mdadm' ? 'user-data' : 'user-data.hardware'), path.join(staging, 'nocloud/user-data'));
  atomic(path.join(staging, 'nocloud/meta-data'), `instance-id: r640-${Date.now()}\nlocal-hostname: ${site.hostname.split('.')[0]}\n`);
  run('xorriso', ['-osirrox', 'on', '-indev', options.iso, '-extract', '/boot/grub/grub.cfg', path.join(staging, 'grub.cfg')]);
  let grub = fs.readFileSync(path.join(staging, 'grub.cfg'), 'utf8');
  if (!/linux\s+\/casper\/vmlinuz/.test(grub)) throw new Error('unexpected Ubuntu boot menu');
  grub = grub.replace(/^(\s*linux\s+\/casper\/vmlinuz[^\n]*?)\s+---/gm, '$1 autoinstall ds=nocloud\\;s=/cdrom/nocloud/ orgiast.confirm-wipe=1 ---').replace(/set timeout=\d+/g, 'set timeout=0');
  atomic(path.join(staging, 'grub.cfg'), grub);
  run('xorriso', ['-indev', options.iso, '-outdev', options.output, '-boot_image', 'any', 'replay', '-map', path.join(staging, 'grub.cfg'), '/boot/grub/grub.cfg', '-map', path.join(staging, 'nocloud'), '/nocloud', '-map', path.join(staging, 'orgiast'), '/orgiast', '-map', path.join(staging, 'private'), '/private']);
  fs.chmodSync(options.output, 0o600);
  atomic(`${options.output}.json`, JSON.stringify({ [site.storageMode]: { storageMode: site.storageMode, diskSerials: site.diskSerials, minimumDiskGiB: site.minimumDiskGiB, sha256: await sha256(options.output), url: options.url } }, null, 2));
  console.log(`OK: prepared storage=${site.storageMode}; ISO and manifest restricted; remote boot unverified`);
} catch { console.error('FAIL: ISO preparation; check confirmation, arguments, approved ISO checksum, site and xorriso'); process.exitCode = 1; }
finally { if (staging) fs.rmSync(staging, { recursive: true, force: true }); }
