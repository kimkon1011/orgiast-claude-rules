import os from 'node:os';
import { ownerPcMap } from './fleet-owner.mjs';

export function displayPcNames(text, { home = process.env.ORGIAST_HOME || os.homedir(), pcMap = ownerPcMap(home) } = {}) {
  const names = new Map();
  for (const [key, row] of Object.entries(pcMap)) {
    if (key.startsWith('_') || !row || typeof row !== 'object') continue;
    const label = [row.remoteName, row.sheetName, key].find(value => /作業用\d{3}/.test(value || ''))?.match(/作業用\d{3}/)[0];
    if (!label) continue;
    for (const name of [key, row.hostname, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      if (typeof name === 'string' && name) names.set(name.toLowerCase(), label);
    }
  }
  if (!names.size) return String(text || '');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...names.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9_-])`, 'gi');
  return String(text || '').replace(pattern, name => names.get(name.toLowerCase()));
}
