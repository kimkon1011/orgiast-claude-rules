import { createSign } from 'node:crypto';

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
const SUMMARY_HEADERS = ['媒体名', '種別', '想定年齢層', '出典', '月額プラン説明', '月額費用(円)', '最低スポット単価(円)', '確信度', '備考', '調査日'];
const RATE_HEADERS = ['媒体名', '種別', '月額費用(円)', '1秒あたりコスパ(円/月)', 'リーチ単価指標'];
const base64url = (value: string): string => Buffer.from(value).toString('base64url');
function fatal(message: string): never { console.error(message); process.exit(1); }

async function token(): Promise<string> {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
  const subject = process.env.GOOGLE_IMPERSONATE_EMAIL;
  if (!encoded || !subject) fatal('GOOGLE_SERVICE_ACCOUNT_KEY_B64 and GOOGLE_IMPERSONATE_EMAIL are required');
  const account = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: account.client_email, sub: subject, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: account.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');
  const response = await fetch(account.token_uri ?? 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }) });
  const payload = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !payload.access_token) fatal(payload.error_description ?? `OAuth error ${response.status}`);
  return payload.access_token;
}

async function api<T>(url: string, accessToken: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) fatal(`Sheets API error ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function main(): Promise<void> {
  const accessToken = await token();
  const created = await api<{ spreadsheetId: string; spreadsheetUrl: string }>('https://sheets.googleapis.com/v4/spreadsheets', accessToken, { properties: { title: 'gakkai-media-research' } });
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(created.spreadsheetId)}`;
  await api(`${base}:batchUpdate`, accessToken, { requests: [{ updateSheetProperties: { properties: { sheetId: 0, title: 'サマリ' }, fields: 'title' } }, { addSheet: { properties: { title: 'レート' } } }] });
  await api(`${base}/values:batchUpdate`, accessToken, { valueInputOption: 'RAW', data: [{ range: 'サマリ!A1:J1', values: [SUMMARY_HEADERS] }, { range: 'レート!A1:E1', values: [RATE_HEADERS] }] });
  console.log(JSON.stringify({ spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit` }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
