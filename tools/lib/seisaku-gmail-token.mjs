import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RELAY_USER = 'seisaku-team@orgiast.jp';
export const relayStatePath = () => join(homedir(), '.claude', 'seisaku-gmail-token.json');
const cache = new Map();

export async function tryRelayToken({ keyPath, impersonate, scope, signal, fetchImpl = globalThis.fetch, statePath = relayStatePath() }) {
  const scopes = String(scope).trim().split(/\s+/u);
  if (process.env.GOOGLE_SA_KEY !== undefined || existsSync(keyPath) || impersonate !== RELAY_USER ||
      !scopes.length || !scopes.every(s => /^https:\/\/www\.googleapis\.com\/auth\/gmail\.(compose|modify|readonly|send)$/u.test(s)) || !existsSync(statePath)) return null;
  let state;
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
  catch { throw Object.assign(new Error('seisaku-gmail-token: 未承認または失敗（状態ファイルを読み込めません）。承認 URL: 状態ファイルの webAppUrl を確認してください'), { errorKind: 'seisaku_relay' }); }
  if (!state || typeof state !== 'object') throw new Error('seisaku-gmail-token: 状態ファイルの形式が不正です');
  const failure = summary => Object.assign(new Error(`seisaku-gmail-token: 未承認または失敗（${summary}）。承認 URL: ${state.webAppUrl}`), { errorKind: 'seisaku_relay' });
  if (state.user !== RELAY_USER || !state.secret || !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/u.test(state.webAppUrl)) throw failure('設定不正');
  const cacheKey = JSON.stringify([state.webAppUrl, state.secret]);
  const saved = cache.get(cacheKey);
  if (saved && saved.until > Date.now()) return saved.token;
  let res;
  try { res = await fetchImpl(state.webAppUrl, { method: 'POST', signal: signal ?? AbortSignal.timeout(25000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: state.secret }) }); }
  catch { throw failure('通信エラー'); }
  let body;
  try { body = await res.json(); } catch { throw failure('JSON 以外の応答・権限承認が必要'); }
  if (!res.ok || body.ok !== true || body.user !== RELAY_USER || typeof body.accessToken !== 'string' || !body.accessToken || !Number.isFinite(body.expiresInSec) || body.expiresInSec <= 0) throw failure(`HTTP ${res.status}・認証応答不正`);
  cache.set(cacheKey, { token: body.accessToken, until: Date.now() + Math.max(0, Math.min(body.expiresInSec, 3300) - 30) * 1000 });
  return body.accessToken;
}
