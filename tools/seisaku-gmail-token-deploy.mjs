#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isEntry } from './is-entry.mjs';
import { RELAY_USER, relayStatePath } from './lib/seisaku-gmail-token.mjs';

export async function deploy({ dryRun = false, statePath = relayStatePath(), authPath = join(homedir(), '.clasprc.json'), fetchImpl = globalThis.fetch } = {}) {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  if (state.user && state.user !== RELAY_USER) throw new Error('状態ファイルのユーザーが seisaku-team@orgiast.jp ではありません');
  if (dryRun) return { dryRun: true, user: RELAY_USER, project: state.scriptId ? 'reuse' : 'create', deployment: state.deploymentId ? 'update' : 'create' };
  const credentials = JSON.parse(readFileSync(authPath, 'utf8')).tokens?.seisaku;
  if (!credentials?.refresh_token || !credentials.client_id || !credentials.client_secret) throw new Error('clasp -u seisaku login を seisaku-team@orgiast.jp で実行してください');
  const refresh = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token, client_id: credentials.client_id, client_secret: credentials.client_secret }), signal: AbortSignal.timeout(25000) });
  const auth = await refresh.json();
  if (!refresh.ok || !auth.access_token) throw new Error('clasp seisaku の認証更新に失敗しました');
  async function api(path, method, body) {
    const res = await fetchImpl(`https://script.googleapis.com/v1/projects${path}`, { method, headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`Apps Script API: HTTP ${res.status}`);
    return res.json();
  }
  const save = () => { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); chmodSync(statePath, 0o600); };
  state.secret ||= randomBytes(24).toString('hex');
  if (!/^[a-f0-9]{48}$/u.test(state.secret)) throw new Error('状態ファイルの secret の形式が不正です');
  state.user = RELAY_USER;
  if (!state.scriptId) {
    state.scriptId = (await api('', 'POST', { title: 'seisaku-gmail-token' })).scriptId;
  }
  save(); // Keep project and secret even if content upload or authorization fails.
  const root = new URL('../gas/seisaku-gmail-token/', import.meta.url);
  const code = readFileSync(new URL('Code.js', root), 'utf8').replace("const RELAY_SECRET = '__RELAY_SECRET__';", `const RELAY_SECRET = '${state.secret}';`);
  await api(`/${state.scriptId}/content`, 'PUT', { files: [
    { name: 'Code', type: 'SERVER_JS', source: code },
    { name: 'appsscript', type: 'JSON', source: readFileSync(new URL('appsscript.json', root), 'utf8') },
  ] });
  const version = await api(`/${state.scriptId}/versions`, 'POST', { description: 'seisaku Gmail token relay' });
  const deployment = await api(`/${state.scriptId}/deployments${state.deploymentId ? '/' + state.deploymentId : ''}`, state.deploymentId ? 'PUT' : 'POST', state.deploymentId ? { deploymentConfig: { versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: 'seisaku Gmail token relay' } } : { versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: 'seisaku Gmail token relay' });
  state.deploymentId = deployment.deploymentId;
  state.webAppUrl = deployment.entryPoints?.find(e => e.webApp)?.webApp.url ?? state.webAppUrl;
  save();
  return { scriptId: state.scriptId, deploymentId: state.deploymentId, webAppUrl: state.webAppUrl, authorizationUrl: `https://script.google.com/home/projects/${state.scriptId}/edit` };
}
if (isEntry(import.meta.url)) {
  deploy({ dryRun: process.argv.includes('--dry-run') }).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('seisaku-gmail-token: デプロイ失敗。clasp seisaku の認証・Apps Script API・状態ファイルを確認してください'); process.exitCode = 1; });
}
