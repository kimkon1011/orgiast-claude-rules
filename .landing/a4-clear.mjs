import { getDriveToken } from '../tools/lib/drive-auth.mjs';
const ID = '17maZ2pzk1wgct0r4kU9A3rUCIlTL7768_Z_Vzsw-4iA';
const API = `https://sheets.googleapis.com/v4/spreadsheets/${ID}`;
const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/spreadsheets', impersonate: 'kim@orgiast.jp', signal: AbortSignal.timeout(30_000) });
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function req(suffix, method = 'GET') {
  const r = await fetch(`${API}${suffix}`, { method, headers: H, ...(method === 'POST' ? { body: '{}' } : {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${suffix} HTTP ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
}
const A4 = encodeURIComponent("'勤務態度'!A4");
const before = (await req(`/values/${A4}?valueRenderOption=FORMULA`)).values?.[0]?.[0] ?? '';
console.log('BEFORE_A4=' + JSON.stringify(before));
if (!before) { console.log('RESULT=already-empty'); process.exit(0); }
if (!/IMPORTRANGE/i.test(String(before))) { console.log('RESULT=abort-not-importrange'); process.exit(0); }
const cleared = await req(`/values/${A4}:clear`, 'POST');
console.log('CLEARED_RANGE=' + cleared.clearedRange);
const after = (await req(`/values/${A4}?valueRenderOption=FORMULA`)).values?.[0]?.[0] ?? '';
console.log('AFTER_A4=' + JSON.stringify(after));
const grid = (await req(`/values/${encodeURIComponent("'勤務態度'!A1:I12")}`)).values ?? [];
console.log('A1_I12=' + JSON.stringify(grid));
console.log('RESULT=' + (after === '' ? 'cleared' : 'not-empty'));
