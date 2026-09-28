// 備品在庫管理表のヘッダと工具関連行を全列で取得（読み取り専用）
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
const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/備品在庫管理表!A:F?majorDimension=ROWS`, { headers: { Authorization: `Bearer ${token}` } });
const j = await r.json();
const rows = j.values ?? [];
console.log(`total rows: ${rows.length}`);
console.log('### header rows (1-3):');
for (const row of rows.slice(0, 3)) console.log('  ' + JSON.stringify(row));
const pat = /工具|クランプ|ベルト|タケノコ|たけのこ|筍|脚立|ドライバー|ラチェット|レンチ|プライヤー|ハンマー|ペンチ/;
const hits = rows.map((row, i) => [i + 1, row]).filter(([, row]) => pat.test(row.join('\t')));
console.log(`### 工具系ヒット (${hits.length}):`);
for (const [n, row] of hits) console.log(`  r${n}: ${row.join(' | ')}`);
