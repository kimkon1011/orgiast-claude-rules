import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export function defaultDriveKeyPath() {
  return join(homedir(), 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.gcp', 'sheets-sa.json');
}

const b64url = (value) => Buffer.from(value).toString('base64url');

export async function getDriveToken({
  keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath(),
  impersonate = process.env.GOOGLE_IMPERSONATE ?? 'kim@orgiast.jp',
  scope = DRIVE_SCOPE,
} = {}) {
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
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`token error: ${JSON.stringify(json)}`);
  return json.access_token;
}

export async function driveApi(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}
