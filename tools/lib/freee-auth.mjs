// Shared freee OAuth lifecycle, extracted unchanged from freee-query.mjs.
// Accounting endpoints are GET-only. The existing OAuth refresh is the sole POST.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const EXPIRY_MARGIN_MS = 120 * 1000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadDbUrl() {
  if (process.env.PURCHASING_APP_DATABASE_URL) return process.env.PURCHASING_APP_DATABASE_URL;
  // nightly-repo (~/.claude/nightly-repo) has no .env.local: fall back to the main working tree.
  const candidates = [join(ROOT, '.env.local'), join(homedir(), 'orgiast-main', '.env.local')];
  const envPath = candidates.find((f) => existsSync(f)) || candidates[0];
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?PURCHASING_APP_DATABASE_URL\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  throw new Error('PURCHASING_APP_DATABASE_URL が .env.local に見つかりません');
}


export async function getAccessToken() {
  const sql = postgres(loadDbUrl(), { max: 1, ssl: 'require', onnotice: () => {} });
  try {
    const [row] = await sql`select client_id, client_secret, refresh_token, access_token, access_expires_at
      from freee_tokens where id = 'default' limit 1`;
    if (!row) throw new Error('freee_tokens に default 行がありません');
    if (row.access_token && row.access_expires_at && new Date(row.access_expires_at).getTime() > Date.now() + EXPIRY_MARGIN_MS) {
      return row.access_token;
    }
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: row.client_id,
        client_secret: row.client_secret,
        refresh_token: row.refresh_token,
      }),
    });
    if (!res.ok) throw new Error(`freee トークン更新に失敗: HTTP ${res.status}`);
    const j = await res.json();
    const expiresAt = new Date(Date.now() + j.expires_in * 1000);
    await sql`update freee_tokens set refresh_token = ${j.refresh_token}, access_token = ${j.access_token},
      access_expires_at = ${expiresAt}, updated_at = now() where id = 'default'`;
    return j.access_token;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
