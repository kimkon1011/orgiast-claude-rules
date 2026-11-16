import { proxyCredential, gwsFetch, GWS_USER } from './gws-proxy.mjs';
import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEnvValue } from '../env-kv.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export function defaultDriveKeyPath() {
  return join(homedir(), 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.gcp', 'sheets-sa.json');
}

/** SA 鍵 JSON を GOOGLE_SERVICE_ACCOUNT_JSON（env）→ ~/.claude/workspace-sa.env の順で読む。*/
function readServiceAccountJson() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || readEnvValue(join(homedir(), '.claude', 'workspace-sa.env'), 'GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('サービスアカウントJSONのパースに失敗しました'); }
  if (typeof parsed.client_email !== 'string' || !parsed.client_email || typeof parsed.private_key !== 'string' || !parsed.private_key) {
    throw new Error('サービスアカウントJSONの形式が不正です（client_email/private_key が不足）');
  }
  return parsed;
}

/** SA 本人モード: JWT に sub を付けず、SA 自身の access token を取得する。*/
export async function getServiceAccountToken({
  scope = DRIVE_SCOPE,
  signal,
  fetchImpl = globalThis.fetch,
} = {}) {
  const sa = readServiceAccountJson();
  if (!sa) throw new Error('サービスアカウントJSONが見つかりません（GOOGLE_SERVICE_ACCOUNT_JSON または ~/.claude/workspace-sa.env）');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(sa.private_key, 'base64url')}`;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`token error: ${JSON.stringify(json)}`);
  return json.access_token;
}

const b64url = (value) => Buffer.from(value).toString('base64url');

export async function getDriveToken({
  keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath(),
  impersonate = process.env.GOOGLE_IMPERSONATE ?? (existsSync(keyPath) ? 'kim@orgiast.jp' : GWS_USER),
  scope = DRIVE_SCOPE,
  signal,
  fetchImpl = globalThis.fetch,
  statePath,
  asServiceAccount = false,
} = {}) {
  if (asServiceAccount) return getServiceAccountToken({ scope, signal, fetchImpl });
  const relay = proxyCredential({ keyPath, impersonate, scope });
  if (relay !== null) return relay;
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    sub: impersonate,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, 'base64url')}`;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`token error: ${JSON.stringify(json)}`);
  return json.access_token;
}

export async function driveApi(token, url, opts = {}) {
  const res = await gwsFetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}
