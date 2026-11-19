import { createSign } from 'node:crypto';
interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
type Row = [string, string, string, string, string, number | string, number | string, string, string, string];
const b64 = (value: string): string => Buffer.from(value).toString('base64url');
function fatal(message: string): never { console.error(message); process.exit(1); }
async function token(): Promise<string> { const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, sub = process.env.GOOGLE_IMPERSONATE_EMAIL; if (!key || !sub) fatal('GOOGLE_SERVICE_ACCOUNT_KEY_B64 and GOOGLE_IMPERSONATE_EMAIL are required'); const sa = JSON.parse(Buffer.from(key, 'base64').toString('utf8')) as ServiceAccount, now = Math.floor(Date.now() / 1000), aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token'; const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: sa.client_email, sub, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud, iat: now, exp: now + 3600 }))}`; const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`; const res = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) }); const data = await res.json() as { access_token?: string; error_description?: string }; if (!res.ok || !data.access_token) fatal(data.error_description ?? `OAuth error ${res.status}`); return data.access_token; }
const yen = (value: number): string => `${Math.round(value).toLocaleString('ja-JP')}円`;
async function main(): Promise<void> {
  const id = process.env.GAKKAI_MEDIA_SPREADSHEET_ID; if (!id) fatal('GAKKAI_MEDIA_SPREADSHEET_ID is required'); const accessToken = await token();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent('サマリ!A2:J')}`, { headers: { Authorization: `Bearer ${accessToken}` } }); if (!res.ok) fatal(`Sheets API error ${res.status}: ${await res.text()}`); const data = await res.json() as { values?: Row[] }; const rows = (data.values ?? []).filter((row) => row[0]);
  const monthly = [...rows].sort((a, b) => Number(a[5]) - Number(b[5])), spots = [...rows].sort((a, b) => Number(a[6]) - Number(b[6]));
  const types = ['新聞', '雑誌', 'Web', 'ラジオ', 'テレビ'];
  console.log('# 媒体広告コスパ比較レポート\n\n## 月額費用の低い順\n'); monthly.forEach((row, i) => console.log(`${i + 1}. ${row[0]}（${row[1]}）— ${yen(Number(row[5]))}`));
  console.log('\n## 種別ごとの平均費用\n'); for (const type of types) { const group = rows.filter((row) => row[1] === type && Number.isFinite(Number(row[5]))); if (group.length) console.log(`- ${type}: ${yen(group.reduce((sum, row) => sum + Number(row[5]), 0) / group.length)}（${group.length}媒体）`); }
  console.log('\n## 最低スポット単価の低い順\n'); spots.forEach((row, i) => console.log(`${i + 1}. ${row[0]} — ${yen(Number(row[6]))}`));
  console.log('\n## 備考・注意事項\n'); rows.filter((row) => row[8]).forEach((row) => console.log(`- **${row[0]}**: ${row[8]}（確信度: ${row[7]}、調査日: ${row[9]}）`));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
