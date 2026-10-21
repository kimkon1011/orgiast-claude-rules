import { getDriveToken } from '../tools/lib/drive-auth.mjs';
const ID = '17maZ2pzk1wgct0r4kU9A3rUCIlTL7768_Z_Vzsw-4iA';
const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/spreadsheets', impersonate: 'kim@orgiast.jp', signal: AbortSignal.timeout(30_000) });
for (const [range, opt] of [["'勤務態度'!A1:I12", 'FORMULA'], ["'勤務態度'!A1:I12", 'FORMATTED_VALUE']]) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ID}/values/${encodeURIComponent(range)}?valueRenderOption=${opt}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(opt, r.status, JSON.stringify((await r.json()).values ?? []));
}
