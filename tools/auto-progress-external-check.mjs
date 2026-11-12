#!/usr/bin/env node
// auto-progress の check として使う外部チャネル（LINE/Discord/Beeper/Gmail）の新着照会。
// 使い方: node tools/auto-progress-external-check.mjs --channel line --thread-id <groupId> --since <ISO日時>
//   exit 1 = 新着なし（unmet、継続監視）、exit 3 = 確認不能（stalled）
//   新着あり: exit 1 に加え ##EXTERNAL_RESULT##JSON マーカー付きで新着を stdout に出力
//   CLI は診断出力のみ。watch の pollExternal が通知成功後に --since を更新し継続監視する。
//   環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { loadSecrets, resolveGroup } from './line-group-send.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { headerValue, extractBody } from './gmail-search.mjs';

const sbHeaders = s => ({
  apikey: s.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${s.SUPABASE_SERVICE_ROLE_KEY}`,
});

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') o.channel = argv[++i];
    else if (a === '--thread-id') o.threadId = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--home') o.home = argv[++i];
    else if (a === '--mailbox') o.mailbox = argv[++i];
    else throw new Error(`不明なオプション: ${a}\n使い方: node tools/auto-progress-external-check.mjs --channel line|discord|beeper|gmail --thread-id <id> --since <ISO日時> [--home <path>]`);
  }
  if (!o.channel || !o.threadId || !o.since) throw new Error('--channel, --thread-id, --since は必須です');
  if (!['line', 'discord', 'beeper', 'gmail'].includes(o.channel)) throw new Error(`未対応チャネル: ${o.channel}`);
  if (!Number.isFinite(Date.parse(o.since))) throw new Error('--since は有効な ISO 日時で指定してください');
  return o;
}

/** Supabase の channel_messages テーブルから新着を照会する。 */
export async function fetchLineMessages(secrets, threadId, since, { fetchImpl = gwsFetch, inclusive = false } = {}) {
  const all = [];
  for (let offset = 0; ; offset += 500) {
  const url = `${secrets.SUPABASE_URL}/rest/v1/channel_messages`
    + `?select=id,external_message_id,created_at,sender_display_name,body,direction`
    + `&channel=eq.line&external_thread_id=eq.${encodeURIComponent(threadId)}`
    + `&created_at=${inclusive ? 'gte' : 'gt'}.${encodeURIComponent(since)}`
    + `&order=created_at.asc,id.asc&limit=500&offset=${offset}`;
  const r = await fetchImpl(url, { headers: sbHeaders(secrets), signal: AbortSignal.timeout(20000) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Supabase HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('Supabase 応答が配列ではありません');
  all.push(...rows);
  if (rows.length < 500) break;
  }
  // 自社（direction=outbound）を除く新着を抽出
  const external = all.filter(row => row.direction !== 'outbound' && row.direction !== 'self');
  return external.map(row => ({
    id: row.external_message_id || row.id,
    at: row.created_at,
    sender: row.sender_display_name,
    text: Array.from(String(row.body || '')).slice(0, 200).join(''),
  }));
}

export async function fetchGmailMessages(threadId, since, { mailbox = 'seisaku-team@orgiast.jp', fetchImpl = gwsFetch, getToken = getDriveToken, inclusive = false } = {}) {
  const token = await getToken({ scope: 'https://www.googleapis.com/auth/gmail.readonly', impersonate: mailbox, signal: AbortSignal.timeout(20000) });
  const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Gmail HTTP ${response.status}`);
  const thread = await response.json();
  if (!Array.isArray(thread.messages)) throw new Error('Gmail messages missing');
  return thread.messages.filter(m => !(m.labelIds || []).some(l => ['SENT', 'DRAFT'].includes(l)) && (inclusive ? Number(m.internalDate) >= Date.parse(since) : Number(m.internalDate) > Date.parse(since)))
    .map(m => ({ id: m.id, at: new Date(Number(m.internalDate)).toISOString(), sender: headerValue(m.payload, 'from'),
      text: Array.from(extractBody(m.payload, 4000) || m.snippet || '').slice(0, 200).join('') }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export async function fetchMessages({ channel, threadId, since, home = process.env.ORGIAST_HOME || os.homedir(), ...options }) {
  if (channel === 'gmail') return fetchGmailMessages(threadId, since, options);
  if (channel !== 'line') throw new Error(`未対応チャネル: ${channel}`);
  const secrets = options.secrets || await loadSecrets({ home });
  if (!secrets.SUPABASE_URL || !secrets.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase credentials missing');
  return fetchLineMessages(secrets, threadId, since, options);
}

export async function check({ channel, threadId, since, mailbox, home = os.homedir(), secrets: givenSecrets, fetchImpl = gwsFetch }) {
  if (channel === 'line') {
    const secrets = givenSecrets || await loadSecrets({ home }).catch(() => ({}));
    if (!secrets.SUPABASE_URL || !secrets.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていません');
      process.exitCode = 3;
      return;
    }
    const id = String(threadId).includes('@') ? await resolveGroup(secrets, threadId) : threadId;
    let messages;
    try { messages = await fetchLineMessages(secrets, id, since, { fetchImpl }); }
    catch (error) {
      console.error(`LINE新着照会失敗: ${error.message}`);
      process.exitCode = 3;
      return;
    }
    if (messages.length === 0) {
      console.log(`外部チャネル(line) に新着なし（${since} 以降）`);
      process.exitCode = 1;
      return;
    }
    const latest = messages[messages.length - 1];
    console.log(`✅ 外部チャネル(line) に新着 ${messages.length}件（最新: ${latest.at} ${latest.sender}: ${latest.text.slice(0, 80)}）`);
    // Structured diagnostic output; watch uses fetchMessages and its durable event queue.
    console.log('##EXTERNAL_RESULT##' + JSON.stringify({
      channel, threadId: id,
      count: messages.length,
      messages: messages.map(m => ({ id: m.id, at: m.at, sender: m.sender, text: m.text })),
      latestAt: latest.at,
    }));
    // A reply is an event, not completion of the continuous monitor.
    process.exitCode = 1;
    return;
  }
  if (channel === 'discord') {
    // Discord は別経路（discord-read-window / Bot API）で照会
    console.error('Discord チャネルの新着照会は未実装です');
    process.exitCode = 3;
    return;
  }
  if (channel === 'beeper') {
    console.error('Beeper チャネルの新着照会は未実装です');
    process.exitCode = 3;
    return;
  }
  if (channel === 'gmail') {
    const messages = await fetchGmailMessages(threadId, since, { mailbox, fetchImpl });
    console.log(JSON.stringify({ messages }));
    process.exitCode = messages.length ? 0 : 1;
    return;
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    await check(opts);
  } catch (error) {
    console.error(`auto-progress-external-check: ${error.message}`);
    process.exitCode = 3;
  }
}

if (isEntry(import.meta.url)) main();
