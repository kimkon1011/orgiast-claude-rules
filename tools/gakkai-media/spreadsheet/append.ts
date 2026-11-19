import { createSign } from 'node:crypto';
import { findByName } from '../media-master.ts';

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
interface Input { media_name: string; monthly_plan: { description: string; cost_yen_per_month: number }; min_spot_cost_yen: number; confidence: string; notes: string }
const b64 = (value: string): string => Buffer.from(value).toString('base64url');
function fatal(message: string): never { console.error(message); process.exit(1); }
async function readStdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return Buffer.concat(chunks).toString('utf8'); }
async function token(): Promise<string> {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64, sub = process.env.GOOGLE_IMPERSONATE_EMAIL;
  if (!key || !sub) fatal('GOOGLE_SERVICE_ACCOUNT_KEY_B64 and GOOGLE_IMPERSONATE_EMAIL are required');
  const sa = JSON.parse(Buffer.from(key, 'base64').toString('utf8')) as ServiceAccount, now = Math.floor(Date.now() / 1000), aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: sa.client_email, sub, scope: 'https://www.googleapis.com/auth/spreadsheets', aud, iat: now, exp: now + 3600 }))}`;
  const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;
  const res = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data = await res.json() as { access_token?: string; error_description?: string }; if (!res.ok || !data.access_token) fatal(data.error_description ?? `OAuth error ${res.status}`); return data.access_token;
}
async function request<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> { const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...init?.headers } }); if (!res.ok) fatal(`Sheets API error ${res.status}: ${await res.text()}`); return res.json() as Promise<T>; }
async function main(): Promise<void> {
  const id = process.env.GAKKAI_MEDIA_SPREADSHEET_ID; if (!id) fatal('GAKKAI_MEDIA_SPREADSHEET_ID is required');
  const inputs = (await readStdin()).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Input);
  const accessToken = await token(), base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values`;
  const current = await request<{ values?: unknown[][] }>(`${base}/${encodeURIComponent('サマリ!A:J')}`, accessToken); const rows = current.values ?? [];
  for (const item of inputs) { const media = findByName(item.media_name); const row = [item.media_name, media?.type ?? '', media?.reading_demo ?? '', media?.source ?? '', item.monthly_plan.description, item.monthly_plan.cost_yen_per_month, item.min_spot_cost_yen, item.confidence, item.notes, new Date().toISOString().slice(0, 10)]; const index = rows.findIndex((existing, i) => i > 0 && existing[0] === item.media_name); if (index >= 0) rows[index] = row; else rows.push(row); }
  await request(`${base}/${encodeURIComponent(`サマリ!A1:J${Math.max(1, rows.length)}`)}?valueInputOption=RAW`, accessToken, { method: 'PUT', body: JSON.stringify({ values: rows }) });
  console.log(JSON.stringify({ rowCount: Math.max(0, rows.length - 1) }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
