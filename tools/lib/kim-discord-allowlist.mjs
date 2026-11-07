import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function loadAllowlist({ home = process.env.ORGIAST_HOME || os.homedir(), repoRoot = root } = {}) {
  return [path.join(repoRoot, 'config/kim-discord-allowlist.json'), path.join(home, '.claude/kim-discord-allowlist.json')].flatMap(file => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(value.entries) ? value.entries : [];
    } catch {
      return [];
    }
  });
}

export function discordAllowed(text, options = {}) {
  const entries = options.allowlist ?? loadAllowlist(options);
  for (const entry of entries) {
    if (!entry?.category || typeof entry.pattern !== 'string' || !entry.pattern) continue;
    try {
      if (new RegExp(entry.pattern, 'm').test(String(text ?? ''))) {
        return { allowed: true, category: entry.category };
      }
    } catch { /* 不正な正規表現は無視 */ }
  }
  return { allowed: false, category: null };
}
