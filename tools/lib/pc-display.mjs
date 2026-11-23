import os from 'node:os';
import { ownerPcMap } from './fleet-owner.mjs';

export function displayPcNames(text, { home = process.env.ORGIAST_HOME || os.homedir(), pcMap = ownerPcMap(home) } = {}) {
  const names = new Map();
  const numericNames = new Map();
  for (const [key, row] of Object.entries(pcMap)) {
    if (key.startsWith('_') || !row || typeof row !== 'object') continue;
    const label = [row.remoteName, row.sheetName, key].find(value => /作業用\d{3}/.test(value || ''))?.match(/作業用\d{3}/)[0];
    if (!label) continue;
    for (const name of [key, row.hostname, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      if (typeof name !== 'string' || !name) continue;
      const target = /^\d{1,4}$/.test(name) ? numericNames : names;
      target.set(name.toLowerCase(), label);
    }
  }
  if (!names.size && !numericNames.size) return String(text || '');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let result = String(text || '');
  if (names.size) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${[...names.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9_-])`, 'gi');
    result = result.replace(pattern, name => names.get(name.toLowerCase()));
  }
  if (numericNames.size) {
    const contexts = ['hostname', 'マシン', '作業用', 'ホスト', 'host', 'ＰＣ', 'PC', '席'];
    const numbers = [...numericNames.keys()].sort((a, b) => b.length - a.length).map(escape).join('|');
    const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${contexts.map(escape).join('|')})\\s*(${numbers})(?![A-Za-z0-9_-])`, 'gi');
    result = result.replace(pattern, (_match, number) => numericNames.get(number.toLowerCase()));
  }
  return result;
}
