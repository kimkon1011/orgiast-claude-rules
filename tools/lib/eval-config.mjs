// eval-harness と model-scout が共有する設定読み込み。eval-harness.mjs に置くと
// eval-harness.mjs → import('./model-scout.mjs') → eval-harness.mjs が循環し、exit 13 で黙って止まる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function userHome() { const h = os.homedir(), m = process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i); return process.env.USERPROFILE || m?.[1] || h; }

// ローカル候補は nightly-repo の reset --hard / clean の対象外に置く。
export function readConfig({ configFile = path.join(TOOLS_DIR, 'eval-providers.json'), overlayFile = path.join(userHome(), '.claude', 'eval', 'providers.local.json') } = {}) {
  const read = (file) => {
    try {
      const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(entries) || entries.some((x) => !x || typeof x.provider !== 'string' || typeof x.model !== 'string')) return [];
      return entries;
    } catch { return []; }
  };
  const merged = new Map();
  for (const entry of [...read(configFile), ...read(overlayFile)]) {
    merged.set(JSON.stringify([entry.provider, entry.model]), entry);
  }
  return [...merged.values()];
}
