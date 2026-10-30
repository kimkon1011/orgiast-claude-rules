#!/usr/bin/env node
import { readJson, validateSite } from '../lib/core.mjs';
import { secrets } from '../lib/keyserve.mjs';
import { Redfish, bootstrap } from '../lib/redfish.mjs';

try {
  const opts = { perc: 'auto', storage: 'auto' };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--confirm-wipe') opts.confirmWipe = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (['--perc', '--storage', '--site', '--images'].includes(a)) { if (!process.argv[i + 1]) throw new Error('argument missing'); opts[a.slice(2)] = process.argv[++i]; }
    else throw new Error('unknown argument');
  }
  if (opts.dryRun) console.log('PLAN: confirmation -> keyserve -> PERC inventory/SSD serials -> controller mode/RAID1 -> job/readback -> prepared ISO -> UEFI one-time boot; no iDRAC access');
  else {
    if (!opts.confirmWipe) throw new Error('--confirm-wipe required before keyserve or iDRAC access');
    const site = validateSite(readJson(opts.site));
    const images = readJson(opts.images);
    const data = await secrets();
    const result = await bootstrap(new Redfish(data), { ...opts, site, images });
    console.log(`OK: controller=${result.controller} storage=${result.storage} media=mounted host=unverified`);
  }
} catch { console.error('FAIL: bootstrap; validate confirmation, site/images, keyserve, TLS, inventory and iDRAC jobs (credentials/remote responses suppressed)'); process.exitCode = 1; }
