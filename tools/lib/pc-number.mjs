import fs from 'node:fs';
import os from 'node:os';

// Resolve from this module's repository, independent of the caller's cwd.
export function resolvePcNumber({ env = process.env, hostname = os.hostname(), mapPath = new URL('../../fleet-pc-map.json', import.meta.url) } = {}) {
  const override = String(env.ORGIAST_PC_NUMBER || '').replace(/[^0-9]/g, '');
  if (override) return override;
  const host = String(hostname).toLowerCase();
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    for (const [key, entry] of Object.entries(map)) {
      if (key.startsWith('_') || !entry || typeof entry !== 'object') continue;
      const names = [entry.hostname, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
      if (!names.some(name => typeof name === 'string' && name.toLowerCase() === host)) continue;
      for (const name of [entry.remoteName, entry.sheetName, key]) {
        const number = typeof name === 'string' && name.match(/作業用(\d{3})/);
        if (number) return number[1];
      }
    }
  } catch { /* Missing or invalid map still permits hostname fallback. */ }
  return String(hostname).match(/作業用(\d{3})/)?.[1] || '';
}
