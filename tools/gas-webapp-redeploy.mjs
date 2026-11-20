#!/usr/bin/env node
// GAS Web アプリが「開けない」時の診断と復旧（URL 不変）。
//
// 背景: 公開設定が ANYONE / コードも正常なのに、利用中デプロイの記録そのものが壊れて
// 「アクセスが拒否されました／ドライブ アクセス権が必要です」を返すことがある
// （2026-10-11 倉庫アプリ @59、2026-10-10 に別 PC が clasp deploy --deploymentId で更新した直後）。
// 復旧は「同じ versionNumber を所有者トークンで PUT 再デプロイ」で、URL は変わらない。
//
// 使い方:
//   node tools/gas-webapp-redeploy.mjs --script <scriptId> --deployment <deploymentId> [--dry-run]
//   （--url を省略すると https://script.google.com/macros/s/<deploymentId>/exec を診断）
//
// 判定は「所有者トークンでの bearer fetch の差分」で行う。所有者で denied なら deployment 記録の壊れ。
// anon で sign-in ページが返るのは ANYONE 設定として正常なので、壊れ判定には使わない。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCRIPT_API = 'https://script.googleapis.com/v1/projects';
export const DENIED_SIGNS = ['アクセスが拒否されました', 'ドライブ アクセス権が必要', 'You need access', 'Access denied', 'Request had insufficient authentication'];
export const SIGNIN_SIGNS = ['Sign in - Google Accounts', 'ログイン - Google アカウント'];

export function execUrlOf(deploymentId) {
  return `https://script.google.com/macros/s/${deploymentId}/exec`;
}

function titleOf(html) {
  return ((html || '').match(/<title>([^<]*)<\/title>/) || [])[1]?.trim() || '';
}

/** HTML から状態を分類する。denied だけが「deployment 記録の壊れ」候補。 */
export function classifyProbe({ status, body, authed }) {
  const title = titleOf(body);
  const hit = (signs) => signs.some((s) => (body || '').includes(s) || title.includes(s));
  if (hit(DENIED_SIGNS)) return { kind: 'denied', title, detail: title || 'アクセス拒否' };
  if (hit(SIGNIN_SIGNS)) return { kind: 'signin', title, detail: authed ? 'トークンが無効/失効' : '未ログイン（ANYONE 設定では正常）' };
  if (status >= 400) return { kind: 'http-error', title, detail: `HTTP ${status}` };
  if (status >= 200 && status < 400 && title) return { kind: 'healthy', title, detail: title };
  return { kind: 'unknown', title, detail: `HTTP ${status}` };
}

/** exec URL を叩いて分類する。authed=true で所有者 bearer を付ける。 */
export async function probeWebApp(url, { token, fetchImpl = fetch } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let res, body;
  try {
    res = await fetchImpl(url, { headers, redirect: 'follow' });
    body = await res.text();
  } catch (error) {
    return { ...(await { kind: 'network-error', title: '', detail: String(error?.message || error) }), status: 0 };
  }
  return { status: res.status, body, ...classifyProbe({ status: res.status, body, authed: Boolean(token) }) };
}

/** ~/.clasprc.json の refresh_token で access token を得る（所有者アカウントのトークン）。 */
export async function getAccessToken({ home = os.homedir(), fetchImpl = fetch } = {}) {
  const file = path.join(home, '.clasprc.json');
  const tokens = JSON.parse(fs.readFileSync(file, 'utf8'))?.tokens?.default;
  if (!tokens?.refresh_token) throw new Error(`refresh_token がありません: ${file}`);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tokens.client_id, client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
    }).toString(),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`トークン更新失敗: ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

export async function getDeployment({ scriptId, deploymentId, token, fetchImpl = fetch }) {
  const res = await fetchImpl(`${SCRIPT_API}/${scriptId}/deployments/${deploymentId}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (res.status !== 200) throw new Error(`deployments.get HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/** 壊れた deployment 記録を、同じ version のまま所有者で PUT し直す（URL 不変）。 */
export async function redeploymentAsOwner({ scriptId, deploymentId, token, fetchImpl = fetch, description }) {
  const current = await getDeployment({ scriptId, deploymentId, token, fetchImpl });
  const cfg = current.deploymentConfig || {};
  const deploymentConfig = {
    versionNumber: cfg.versionNumber,
    manifestFileName: cfg.manifestFileName || 'appsscript',
    description: description || cfg.description || '',
  };
  const res = await fetchImpl(`${SCRIPT_API}/${scriptId}/deployments/${deploymentId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deploymentConfig }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`deployments.update HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return { versionNumber: deploymentConfig.versionNumber, description: deploymentConfig.description };
}

/** 診断 → 必要なら復旧 → 再診断。dryRun では復旧しない。 */
export async function healGasWebApp({ scriptId, deploymentId, url, token, fetchImpl = fetch, dryRun = false, description }) {
  const target = url || execUrlOf(deploymentId);
  const before = await probeWebApp(target, { token, fetchImpl });
  if (before.kind !== 'denied') return { healed: false, action: 'none', before, after: before, target };
  if (dryRun) return { healed: false, action: 'dry-run', before, after: before, target };
  const applied = await redeploymentAsOwner({ scriptId, deploymentId, token, fetchImpl, description });
  const after = await probeWebApp(target, { token, fetchImpl });
  return { healed: after.kind === 'healthy', action: 'redeploy-as-owner', applied, before, after, target };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.script || !args.deployment) {
    console.error('usage: node tools/gas-webapp-redeploy.mjs --script <scriptId> --deployment <deploymentId> [--url <execUrl>] [--dry-run]');
    process.exit(2);
  }
  const token = await getAccessToken({});
  const result = await healGasWebApp({ ...args, scriptId: args.script, deploymentId: args.deployment, token });
  console.log(JSON.stringify({
    target: result.target, action: result.action, healed: result.healed,
    before: { kind: result.before.kind, title: result.before.title, status: result.before.status },
    after: { kind: result.after.kind, title: result.after.title, status: result.after.status },
  }, null, 2));
  process.exit(result.after.kind === 'healthy' ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
