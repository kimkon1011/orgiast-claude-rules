// PC の所有アカウント解決。notify-owner.mjs から切り出した（kim-inbox が notify-owner を
// import すると notify-kim -> kim-inbox -> notify-owner -> notify-kim の静的循環になるため、
// 通知系に依存しないこのモジュールに置く）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFleetLabel } from './fleet-label.mjs';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export function ownerPcMap(home) {
  const map = readJson(path.join(repo, 'fleet-pc-map.json'));
  for (const [label, row] of Object.entries(readJson(path.join(home, '.claude', 'fleet-pc-map.json')))) {
    map[label] = row && typeof row === 'object' ? { ...map[label], ...row } : row;
  }
  return map;
}

export function resolveOwner({ home = os.homedir(), label = resolveFleetLabel(home), pcMap, gitEmail } = {}) {
  const map = pcMap ?? ownerPcMap(home);
  const aliases = Object.entries(map).find(([, value]) => value && typeof value === 'object' && [value.hostname, value.sheetName, value.remoteName, ...(value.aliases || [])].includes(label));
  const configured = map[label] || aliases?.[1];
  if (configured?.account) return configured.account;
  try { return String(gitEmail ?? execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true })).trim(); } catch { return ''; }
}
