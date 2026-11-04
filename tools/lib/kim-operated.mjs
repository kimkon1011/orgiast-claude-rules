// 共有アカウントは PC ごとに操作者が違うので、fleet-pc-map の operator / notifyDiscordId を優先する。
// kim 本人が操作する Claude アカウント（kim 2026-10-28）。この席のセッションは user=kim として扱い、
// kim-PC への判断依頼や「kim は別PCにいる」前提の手渡しをしない。社員本人が使う席はここに入れない。
import fs from 'node:fs';
import path from 'node:path';
import { ownerPcMap } from './fleet-owner.mjs';
import { resolveFleetLabel } from './fleet-label.mjs';
import { KIM_DISCORD_USER_ID } from './kim-identity.mjs';

export const KIM_OPERATED_ACCOUNTS = Object.freeze([
  'kim@orgiast.jp',
  'nishi@orgiast.jp',
  'cr@orgiast.jp',
  'seisaku-team@orgiast.jp',
  'genbateam.toho@gmail.com',
]);

export function claudeAccount(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').replace(/^﻿/, ''))?.oauthAccount?.emailAddress || ''; }
  catch { return ''; }
}

export function isKimOperated(home, account = claudeAccount(home)) {
  const label = resolveFleetLabel(home);
  const map = ownerPcMap(home); // repo の値にローカルのフィールドを上書きする既存のマージ規則。
  const entry = map[label] || Object.values(map).find(row => row && typeof row === 'object'
    && [row.hostname, row.sheetName, row.remoteName, ...(row.aliases || [])].includes(label));
  if (entry && Object.hasOwn(entry, 'operator')) return entry.operator === 'kim';
  if (entry && Object.hasOwn(entry, 'notifyDiscordId')) return entry.notifyDiscordId === KIM_DISCORD_USER_ID;
  return KIM_OPERATED_ACCOUNTS.includes(String(account).trim().toLowerCase());
}
