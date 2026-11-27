// Shared Gmail authentication; no sending CLI dependencies.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { proxyCredential, gwsFetch } from './gws-proxy.mjs';
import { defaultDriveKeyPath } from './drive-auth.mjs';
export const DEFAULT_KEY = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
const b64url = value => Buffer.from(value).toString('base64url');
const configError = () => Object.assign(new Error('設定を確認してください（引数・入力ファイル・SA キー）。'), { errorKind: 'configuration_error' });

export function classifyTokenError(json) {
  return ['invalid_client', 'invalid_grant', 'unauthorized_client'].includes(json?.error) ? 'scope_not_delegated' : 'error';
}

export function safeFailure(error) {
  if (error?.errorKind === 'seisaku_relay') return { errorKind: 'seisaku_relay', error: error.message };
  const errorKind = error?.code === 'SEND_CONTEXT_REQUIRED' || error?.errorKind === 'send_context_required' ? 'send_context_required'
    : error?.errorKind === 'configuration_error' ? 'configuration_error'
    : error?.errorKind === 'too_large' ? 'too_large'
    : error?.tokenError ? classifyTokenError(error.detail)
      : ['scope_not_delegated', 'forbidden_no_access', 'unauthorized'].includes(error?.errorKind) ? error.errorKind : 'error';
  const messages = {
    configuration_error: '設定を確認してください（引数・入力ファイル・SA キー）。',
    scope_not_delegated: 'DWD にこのスコープが未登録。Admin Console で SA client_id に追加が要る',
    forbidden_no_access: 'Gmail API へのアクセス権限がありません。',
    unauthorized: 'Gmail API の認証に失敗しました。',
    too_large: '転送メールが25MBを超えています。',
    send_context_required: error?.message,
    error: '処理に失敗しました（認証・通信・API 応答を確認してください）。',
  };
  const httpStatus = error?.httpStatus;
  const suffix = httpStatus !== undefined ? `（HTTP ${httpStatus}）` : '';
  const result = { errorKind, error: `${messages[errorKind]}${suffix}` };
  if (error?.httpStatus !== undefined) result.detail = `threads.get ${error.httpStatus}`;
  return result;
}

function readKey(keyPath) {
  try {
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8').replace(/^\uFEFF/u, ''));
    if (typeof key.client_email !== 'string' || !key.client_email || typeof key.private_key !== 'string') throw configError();
    const privateKey = crypto.createPrivateKey(key.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa') throw configError();
    return { client_email: key.client_email, privateKey };
  } catch { throw configError(); }
}

export async function mintDwdToken({ user, keyPath = DEFAULT_KEY, scope, fetchImpl = gwsFetch, statePath }) {
  const relay = proxyCredential({ keyPath, impersonate: user, scope });
  if (relay !== null) return relay;
  const key = readKey(keyPath);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: key.client_email, sub: user, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))}`;
  try {
    const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.privateKey).toString('base64url')}`;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || typeof json?.access_token !== 'string' || !json.access_token) {
      throw Object.assign(new Error('トークン取得失敗'), { errorKind: classifyTokenError(json) });
    }
    return json.access_token;
  } catch (error) { throw Object.assign(new Error(safeFailure(error).error), safeFailure(error)); }
}
