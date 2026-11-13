#!/usr/bin/env node
// No subprocesses, file writes, message sends, or configuration changes.
// POST is used only by getDriveToken for OAuth token acquisition.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { channelRequest, gwsFetch, GWS_MARKER } from './lib/gws-proxy.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { keyserveSecret, requireKeyservePcId, keyserveAuthHeaders } from './keyserve-auth.mjs';
import { CASE_ID, resumeText } from './lib/case-handoff.mjs';
import { redactSecrets } from './fleet-agent.mjs';
import { SELFCHECK_PROMPT } from './lib/fleet-selfcheck-prompt.mjs';

const absent = message => Object.assign(new Error(message), { noRoute: true });
function optional(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function bytes(file) {
  const data = fs.readFileSync(file);
  if (!data.length) throw Error(`${file}: empty file`);
  return `${file} / ${data.length} bytes`;
}
export function latestCase(cases, activity = {}) {
  if (!Array.isArray(cases)) throw Error('case catalog: cases must be an array');
  const dated = cases.filter(item => CASE_ID.test(item?.id || '')).map((item, index) => ({ item, index,
    at: Math.max(activity[item.id] || 0, Date.parse(item.updatedAt || item.lastActivityAt || item.modifiedTime || item.createdAt || '') || 0) }));
  dated.sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0) || a.index - b.index);
  return dated[0]?.item ?? null;
}
export function markdownTable(rows, at) {
  const cell = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
  return [`自己点検: ${at}（読み取り専用）`, '', '| 項目・経路 | 結果 | 実測・エラー原文（秘密値は伏字） |', '|---|---|---|',
    ...rows.map(row => `| ${cell(row.item)} | ${cell(row.status)} | ${cell(row.detail)} |`)].join('\n');
}
export async function runSelfcheck({ home = process.env.ORGIAST_HOME || os.homedir(), env = process.env,
  hostname = os.hostname(), fetchImpl = globalThis.fetch, getToken = getDriveToken, now = () => new Date() } = {}) {
  const base = path.join(home, '.claude'), rows = [], secrets = new Set();
  const remember = value => { if (value) secrets.add(value); return value; };
  const safe = value => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return redactSecrets(text);
  };
  async function check(item, probe) {
    try { const detail = await probe(); rows.push({ item, status: '読めた', detail: safe(detail) }); }
    catch (error) { rows.push({ item, status: error.noRoute ? '経路なし' : '失敗', detail: safe(error.message) }); }
  }
  const readEnv = name => parseEnvText(optional(path.join(base, name)) || '');
  async function get(url, headers = {}) {
    const response = await gwsFetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000) }, { home, env, fetchImpl });
    if (!response.ok) throw Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }
  let account = '';
  await check('身元 / アカウント', () => {
    const data = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').replace(/^\uFEFF/, ''));
    account = data.oauthAccount?.emailAddress || '';
    if (!account) throw Error('oauthAccount.emailAddress missing');
    return account;
  });
  await check('身元 / hostname', () => hostname);
  await check('身元 / REPORTER_LABEL', () => readEnv('cost-reporter.env').REPORTER_LABEL || `未設定（fleet は hostname=${hostname} を使用）`);
  for (const name of ['orgiast-mission.md', 'shared-memory/MEMORY.md', 'knowledge/production-sales/00_INDEX.md', 'skills/case/SKILL.md', 'skills/case-resume/SKILL.md']) {
    await check(`配布物 / ${name}`, () => bytes(path.join(base, name)));
  }
  await check('配布物 / CLAUDE.md 制作・営業ナレッジ', () => {
    const file = path.join(home, '.claude', 'CLAUDE.md');
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/).find(line => line.includes('制作・営業ナレッジ'));
    if (!line) throw Error(`${file}: 制作・営業ナレッジ line missing`);
    return line;
  });
  let latest;
  const caseGet = async query => {
    if (!isKimOperated(home, account)) throw Error('case-handoff: kim 操作アカウントのみ利用できます');
    const secret = remember(keyserveSecret(home, env));
    if (!secret) throw absent('keyserve.env / ORGIAST_KEYSERVE_SECRET 未配布');
    const pc = requireKeyservePcId(home, env);
    const url = new URL(env.ORGIAST_CASE_URL || 'https://orgiast-memoryserve.vercel.app/api/case-log');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return get(url, keyserveAuthHeaders(secret, Date.now(), pc));
  };
  await check('case-handoff / catalog', async () => {
    const data = await caseGet({ mode: 'catalog' });
    const activity = {};
    // Resume downloads carry per-case timestamps even when catalog omits dates.
    for (const item of data.cases || []) {
      if (!CASE_ID.test(item?.id || '')) continue;
      for (const name of ['STATE.md', 'LOG.md']) {
        try { activity[item.id] = Math.max(activity[item.id] || 0, fs.statSync(path.join(base, 'case-sessions', item.id, name)).mtimeMs); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const bindings = path.join(base, 'case-binding');
    let names = [];
    try { names = fs.readdirSync(bindings).filter(name => name.endsWith('.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      const file = path.join(bindings, name), binding = JSON.parse(fs.readFileSync(file, 'utf8'));
      const at = Math.max(Number(binding.lastSentAt) || 0, fs.statSync(file).mtimeMs);
      for (const id of binding.cases || []) if (CASE_ID.test(id)) activity[id] = Math.max(activity[id] || 0, at);
    }
    latest = latestCase(data.cases, activity);
    return `${data.cases.length} 件 / ${latest ? `選択: ${latest.name || '名称なし'}（${latest.id}）` : '案件なし'} / 更新日時・このPCの最終利用日時順（両方なしはcatalog順、直近か未確認）`;
  });
  await check('case-handoff / 直近案件 resume', async () => {
    if (!latest) throw absent('catalogから取得対象の案件を選べない');
    const data = await caseGet({ mode: 'resume', caseId: latest.id });
    if (typeof data.state !== 'string' || typeof data.log !== 'string') throw Error('case resume: state/log must be strings');
    return `${latest.name || '名称なし'}（${latest.id}） / ${Buffer.byteLength(resumeText(data.state, data.log), 'utf8')} bytes（UTF-8、保存なし）`;
  });
  const keyPath = env.GOOGLE_SA_KEY || path.join(home, 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.gcp', 'sheets-sa.json');
  const statePath = path.join(base, 'seisaku-gmail-token.json');
  async function googleToken(service, scope) {
    const key = optional(keyPath), relay = service === 'Gmail' ? optional(statePath) : null;
    if (key === null) {
      const credential = remember(keyserveSecret(home, env));
      if (!credential) throw absent(`${service}: keyserve enrollment credential missing`);
      requireKeyservePcId(home, env);
      return GWS_MARKER;
    }
    if (key !== null) remember(JSON.parse(key).private_key);
    if (relay !== null) remember(JSON.parse(relay).secret);
    return remember(await getToken({ keyPath, statePath, impersonate: 'seisaku-team@orgiast.jp', scope, fetchImpl, signal: AbortSignal.timeout(20_000) }));
  }
  await check('Gmail / seisaku-team@orgiast.jp / API', async () => {
    const token = await googleToken('Gmail', 'https://www.googleapis.com/auth/gmail.readonly');
    const data = await get('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1', { Authorization: `Bearer ${token}` });
    if (!Array.isArray(data.messages) && data.resultSizeEstimate !== 0) throw Error('Gmail: invalid messages response');
    if (data.messages?.[0]?.id) await get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(data.messages[0].id)}?format=metadata`, { Authorization: `Bearer ${token}` });
    return `${token === GWS_MARKER ? 'enroll API / ' : ''}messages.list/get 読取成功 / ${data.messages?.length || 0} 件（本文非表示）`;
  });
  await check('Drive / seisaku-team@orgiast.jp / API', async () => {
    // Existing DWD grants drive, not drive.readonly (docs/drive-oldfile-trash-route.md).
    // Reuse that grant; this probe still exposes GET files.list only.
    const token = await googleToken('Drive', 'https://www.googleapis.com/auth/drive');
    const data = await get('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)&q=trashed%3Dfalse', { Authorization: `Bearer ${token}` });
    if (!Array.isArray(data.files)) throw Error('Drive: invalid files response');
    if (data.files[0]?.id) await get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(data.files[0].id)}?fields=id,name`, { Authorization: `Bearer ${token}` });
    return `${token === GWS_MARKER ? 'enroll API / ' : ''}files.list/get 読取成功 / ${data.files.length} 件（内容非表示）`;
  });
  await check('Discord / Bot / メッセージ履歴', async () => {
    const token = remember(env.DISCORD_BOT_TOKEN?.trim() || optional(path.join(base, 'orgiast-discord-bot-token.txt'))?.trim());
    if (!token) throw absent('DISCORD_BOT_TOKEN / orgiast-discord-bot-token.txt 未配布');
    const headers = { Authorization: `Bot ${token}` };
    const channels = await get('https://discord.com/api/v10/guilds/715211007307284530/channels', headers);
    if (!Array.isArray(channels)) throw Error('Discord: invalid channels response');
    const channel = channels.find(c => c.name === 'claude-code' && [0, 5].includes(c.type)) || channels.find(c => [0, 5].includes(c.type));
    if (!channel) throw absent('Discord: 読取対象のテキストチャンネルなし');
    const messages = await get(`https://discord.com/api/v10/channels/${encodeURIComponent(channel.id)}/messages?limit=1`, headers);
    if (!Array.isArray(messages)) throw Error('Discord: invalid messages response');
    return `#${channel.name}（${channel.id}） / ${messages.length} 件（本文非表示、このチャンネルのみ検証）`;
  });
  await check('LINE / 共有API・取り込み済み履歴', async () => {
    if (keyserveSecret(home, env)) {
      const data = await channelRequest('line', { query: { mode: 'history', limit: '1' }, home, env, fetchImpl });
      if (!Array.isArray(data.messages) || !data.messages.length || typeof data.messages[0].text !== 'string' || !data.messages[0].text) throw Error('LINE shared history: no readable message');
      if (!Number.isFinite(data.ageSeconds) || data.ageSeconds > 7200) throw Error(`LINE shared history stale: ${data.syncedAt}`);
      return `enroll API / ${data.messages.length} 件 / 同期=${data.syncedAt} / 最終発言時刻=${data.messages[0].ts}（本文非表示、ライブ受信は未検証）`;
    }
    const store = env.LINE_STORE_DIR || path.join(base, 'line-openchat');
    let names;
    try { names = fs.readdirSync(store); } catch (error) { if (error.code === 'ENOENT') throw absent(`${store}: LINE履歴の取り込み経路なし`); throw error; }
    const file = names.filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort().at(-1);
    if (!file) throw absent(`${store}: 月次履歴ファイルなし（LINEのライブ受信は未検証）`);
    const text = fs.readFileSync(path.join(store, file), 'utf8');
    const record = text.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!record) throw Error(`LINE: ${file} is empty`);
    const message = JSON.parse(record);
    if (typeof message.text !== 'string' || !message.text.trim()) throw Error(`LINE: ${file} last record has no message text`);
    return `${file} / ${Buffer.byteLength(record, 'utf8')} bytes / 最終発言時刻=${message.ts || '不明'}（保存済み履歴のみ。ライブ受信・他PCの共有履歴は未検証）`;
  });
  return { rows, markdown: markdownTable(rows, now().toISOString()) };
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--prompt') { console.log(SELFCHECK_PROMPT); return 0; }
  if (args.length) throw Error('Usage: node tools/fleet-selfcheck.mjs [--prompt]');
  console.log((await runSelfcheck()).markdown);
  return 0; // Per-row failures are diagnostic results, not missing output.
}
if (isEntry(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(error => { console.error(redactSecrets(error.message)); process.exitCode = 1; });
