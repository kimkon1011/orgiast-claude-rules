#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { buildPcIdentityIndex } from './fleet-pc-identity.mjs';
import { isEntry } from './is-entry.mjs';

export function readPcMap() {
  try { return JSON.parse(fs.readFileSync(new URL('../fleet-pc-map.json', import.meta.url), 'utf8')); }
  catch { return {}; }
}
export function resolveSeat(name, pcMap = readPcMap()) {
  const hostname = String(name ?? '').trim();
  const identity = buildPcIdentityIndex(pcMap).find(hostname);
  const seat = identity
    ? String(identity.mapped.remoteName || identity.mapped.sheetName || identity.label)
    : `番号未登録の席（hostname: ${hostname}）`;
  return { hostname, seat, registered: Boolean(identity) };
}
export function selfSeat(pcMap = readPcMap(), hostname = os.hostname()) {
  return resolveSeat(hostname, pcMap);
}
export function seatContext(pcMap = readPcMap(), hostname = os.hostname()) {
  const { seat } = selfSeat(pcMap, hostname);
  return `この席は ${seat}（hostname: ${hostname}）。人向けの文では ${seat} と呼ぶ（§1.5.0.2）。`;
}
if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--resolve');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) {
    console.error('--resolve <name> を指定してください'); process.exitCode = 1;
  } else {
    const result = index >= 0 ? resolveSeat(args[index + 1]) : selfSeat();
    console.log(args.includes('--json') ? JSON.stringify(result) : result.seat);
  }
}
