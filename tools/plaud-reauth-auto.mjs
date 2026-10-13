#!/usr/bin/env node
// Plaud トークン失効の無人復旧。OTP をメール(DWD で kim@ の Gmail を読む)から取り、
// otp-login で access/refresh を取り直して保存先(state + plaud.env)へ書く。
//   node tools/plaud-reauth-auto.mjs            # 常に再ログイン
//   node tools/plaud-reauth-auto.mjs --if-needed # urt が3日以内に切れる/切れている時だけ
// 失敗した時だけ kim に通知する。トークン値は出力しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue, upsertEnvValue } from './env-kv.mjs';
import { searchGmail } from './gmail-search.mjs';
import { isEntry } from './is-entry.mjs';

const API = 'https://api-apne1.plaud.ai';
const USER = 'kim@orgiast.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, 'content-type': 'application/json', origin: 'https://web.plaud.ai', referer: 'https://web.plaud.ai/', accept: 'application/json' };
export const PREVENT_DAYS = 3;
const FAIL_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 失敗後は6時間 OTP メールを送り直さない

const claudeDir = () => path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude');
export const reauthStatePath = () => path.join(claudeDir(), 'plaud-reauth-state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function otpFromSubject(subject) {
  const m = String(subject || '').match(/\b(\d{6})\b\s+is your Plaud login code/i);
  return m ? m[1] : '';
}

/** 送信時刻以降に届いた最新の OTP メールだけ採用する。 */
export function pickOtp(messages, sentAtMs) {
  const fresh = (messages || [])
    .map((m) => ({ code: otpFromSubject(m.subject), t: Date.parse(m.date) }))
    .filter((m) => m.code && Number.isFinite(m.t) && m.t >= sentAtMs - 5000)
    .sort((a, b) => b.t - a.t);
  return fresh[0]?.code || '';
}

export function readReauthState() {
  try { return JSON.parse(fs.readFileSync(reauthStatePath(), 'utf8')); } catch { return {}; }
}
function writeReauthState(patch) {
  fs.writeFileSync(reauthStatePath(), JSON.stringify({ ...readReauthState(), ...patch }, null, 2) + '\n', { mode: 0o600 });
}

/** 直近で失敗していれば再試行しない(OTP メールの連打防止)。 */
export function inCooldown(now = Date.now()) {
  const last = Number(readReauthState().lastFailAt || 0);
  return last && now - last < FAIL_COOLDOWN_MS;
}

export async function loginViaOtp({ fetchImpl = fetch, search = searchGmail, timeoutMs = 180000, pollMs = 5000 } = {}) {
  const sentAt = Date.now();
  const sendRes = await fetchImpl(`${API}/auth/otp-send-code`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ username: USER, user_area: 'JP' }) });
  const sendBody = await sendRes.json().catch(() => ({}));
  const otpToken = sendBody.token || sendBody.data?.token;
  if (!sendRes.ok || !otpToken) throw new Error(`otp-send-code 失敗 HTTP ${sendRes.status}`);

  const after = Math.floor(sentAt / 1000) - 2;
  const deadline = Date.now() + timeoutMs;
  let code = '';
  while (!code && Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const r = await search({ user: USER, query: `from:no-reply@plaud.ai subject:"is your Plaud login code" after:${after}`, max: 5 });
      code = pickOtp(r.messages, sentAt);
    } catch (e) { if (Date.now() >= deadline) throw e; }
  }
  if (!code) throw new Error(`OTP メールが ${Math.round(timeoutMs / 1000)} 秒以内に届きませんでした`);

  const res = await fetchImpl(`${API}/auth/otp-login`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ code, token: otpToken, user_area: 'JP', team_enabled: false }) });
  const body = await res.json().catch(() => ({}));
  const ut = body.access_token || body.data?.access_token || '';
  const urt = body.refresh_token || body.data?.refresh_token || '';
  if (!res.ok || !ut || !urt) throw new Error(`otp-login 失敗 HTTP ${res.status}`);
  const urtExpireAt = body.urt_expire_at ?? body.data?.urt_expire_at ?? null;
  return { ut, urt, urtExpireAt };
}

function jwtExp(token) {
  try { return Number(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).exp) || 0; } catch { return 0; }
}

/** state.session に新トークンを反映(wt は取り直させる)。 */
export function applyToSession(session, { ut, urt }) {
  session.ut = ut; session.urt = urt;
  session.utExp = jwtExp(ut); session.urtExp = jwtExp(urt);
  session.wt = ''; session.wtExp = 0;
  return session;
}

/** bootstrap 用の plaud.env も同じ値にそろえる(state が消えても復旧できるように)。 */
export function writeEnvTokens({ ut, urt }, file = path.join(claudeDir(), 'plaud.env')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 新規 */ }
  text = upsertEnvValue(text, 'PLAUD_UT', ut);
  text = upsertEnvValue(text, 'PLAUD_URT', urt);
  fs.writeFileSync(file, text, { mode: 0o600 });
}

/** run() 内から呼ぶ版。取得して session/env を更新し、成否を返す(失敗時は記録して false)。 */
export async function reauthInto(session, deps = {}) {
  if (inCooldown()) return false;
  try {
    const tokens = await loginViaOtp(deps);
    applyToSession(session, tokens);
    writeEnvTokens(tokens);
    writeReauthState({ lastOkAt: Date.now(), lastFailAt: 0, urtExpireAt: tokens.urtExpireAt, lastError: '' });
    return true;
  } catch (error) {
    writeReauthState({ lastFailAt: Date.now(), lastError: String(error.message).slice(0, 200) });
    return false;
  }
}

async function main() {
  const ifNeeded = process.argv.includes('--if-needed');
  const claude = claudeDir();
  const statePath = path.join(claude, 'plaud-to-tldv-state.json');
  const { readState, writeStateAtomic } = await import('./plaud-to-tldv.mjs');
  if (ifNeeded) {
    const { state } = readState(statePath, {});
    const exp = Number(state.session.urtExp) || 0;
    const days = exp ? (exp * 1000 - Date.now()) / 86400000 : 0;
    if (state.session.urt && days > PREVENT_DAYS) { console.log(`plaud-reauth: urt 残り ${days.toFixed(1)} 日。実行不要`); return 0; }
  }
  const lockPath = `${statePath}.lock`;
  let fd;
  for (let i = 0; i < 60; i += 1) {
    try { fd = fs.openSync(lockPath, 'wx', 0o600); break; } catch (e) { if (e.code !== 'EEXIST') throw e; await sleep(1000); }
  }
  if (fd === undefined) { console.error('plaud-reauth: 同期ジョブのロックが外れません'); return 1; }
  try {
    const tokens = await loginViaOtp();
    const { state } = readState(statePath, {});
    applyToSession(state.session, tokens);
    writeEnvTokens(tokens);
    writeStateAtomic(statePath, state);
    writeReauthState({ lastOkAt: Date.now(), lastFailAt: 0, urtExpireAt: tokens.urtExpireAt, lastError: '' });
    const check = await fetch(`${API}/file/simple/web?skip=0&limit=1&is_trash=2&sort_by=start_time&is_desc=true`, { headers: { ...HEADERS, authorization: `Bearer ${tokens.ut}` } });
    if (!check.ok) throw new Error(`疎通確認 HTTP ${check.status}`);
    console.log(`plaud-reauth: 成功 (API疎通 ${check.status}, urt 期限 ${new Date(jwtExp(tokens.urt) * 1000).toISOString()})`);
    return 0;
  } catch (error) {
    writeReauthState({ lastFailAt: Date.now(), lastError: String(error.message).slice(0, 200) });
    console.error(`plaud-reauth 失敗: ${error.message}`);
    try {
      const { notifyKim } = await import('./notify-kim.mjs');
      await notifyKim(`Plaud の自動再ログインに失敗しました（${error.message}）。Plaud→tl;dv の取り込みが止まる可能性があります。`);
    } catch { /* 通知失敗で本処理は落とさない */ }
    return 1;
  } finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lockPath); } catch {} }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
