// 備品管理表（全体）のシート構成と工具関連行を取得（読み取り専用）
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const b64url = (v) => Buffer.from(v).toString('base64url');
const key = JSON.parse(readFileSync(join(homedir(), 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.gcp', 'sheets-sa.json'), 'utf8'));
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claims = b64url(JSON.stringify({
  iss: key.client_email, sub: 'kim@orgiast.jp',
  scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
}));
const signer = createSign('RSA-SHA256');
signer.update(`${header}.${claims}`);
const jwt = `${header}.${claims}.${signer.sign(key.private_key, 'base64url')}`;
const tres = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
});
const token = (await tres.json()).access_token;

const ssId = '1QCW86DIri6nryqheFKw8Cr6e9Ce0YRV6FvFFW0zqBnc';
const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=sheets(properties(title))`, { headers: { Authorization: `Bearer ${token}` } });
const meta = await metaRes.json();
console.log('### sheets:', meta.sheets?.map((s) => s.properties.title).join(' | '));

// 各シートの先頭2列を取得して「工具/クランプ/ベルト/タケノコ」を含む行を表示
for (const s of meta.sheets ?? []) {
  const title = s.properties.title;
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(title)}!A:B?majorDimension=ROWS`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { console.log(`--- ${title}: skip ${r.status}`); continue; }
  const j = await r.json();
  const rows = j.values ?? [];
  const hits = rows.filter((row) => /工具|クランプ|ベルト|タケノコ|たけのこ|筍/.test(row.join('\t')));
  console.log(`--- ${title} (${rows.length} rows, ${hits.length} hits)`);
  for (const h of hits) console.log(`  ${h.join('\t')}`);
}
