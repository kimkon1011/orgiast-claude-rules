// kim 本人が操作する Claude アカウント（kim 2026-10-28）。この席のセッションは user=kim として扱い、
// kim-PC への判断依頼や「kim は別PCにいる」前提の手渡しをしない。社員本人が使う席はここに入れない。
import fs from 'node:fs';
import path from 'node:path';

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
  return KIM_OPERATED_ACCOUNTS.includes(String(account).trim().toLowerCase());
}
