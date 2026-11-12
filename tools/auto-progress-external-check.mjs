#!/usr/bin/env node
// auto-progress の check として使う外部チャネル（LINE/Discord/Beeper/Gmail）の新着照会。
// 使い方: node tools/auto-progress-external-check.mjs --channel line --thread-id <groupId> --since <ISO日時>
//   exit 0 = 新着あり（done）、exit 1 = まだ（unmet）、exit 3 = 確認不能（stalled）
//   環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { loadSecrets, resolveGroup } from './line-group-send.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));

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
    else throw new Error(`不明なオプション: ${a}\n使い方: node tools/auto-progress-external-check.mjs --channel line|discord|beeper|gmail --thread-id <id> --since <ISO日時> [--home <path>]`);
  }
  if (!o.channel || !o.threadId || !o.since) throw new Error('--channel, --thread-id, --since は必須です');
  if (!['line', 'discord', 'beeper', 'gmail'].includes(o.channel)) throw new Error(`未対応チャネル: ${o.channel}`);
  if (!Number.isFinite(Date.parse(o.since))) throw new Error('--since は有効な ISO 日時で指定してください');
  return o;
}

/** Supabase の channel_messages テーブルから新着を照会する。 */
export async function fetchLineMessages(secrets, threadId, since, { fetchImpl = gwsFetch } = {}) {
  const url = `${secrets.SUPABASE_URL}/rest/v1/channel_messages`
    + `?select=id,created_at,sender_display_name,body,direction`
    + `&channel=eq.line&external_thread_id=eq.${encodeURIComponent(threadId)}`
    + `&created_at=gt.${encodeURIComponent(since)}`
    + `&order=created_at.asc`;
  const r = await fetchImpl(url, { headers: sbHeaders(secrets) });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Supabase HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) throw new Error('Supabase 応答が配列ではありません');
  // 自社（direction=outbound）を除く新着を抽出
  const external = rows.filter(row => row.direction !== 'outbound' && row.direction !== 'self');
  return external.map(row => ({
    id: row.external_message_id || row.id,
    at: row.created_at,
    sender: row.sender_display_name,
    text: String(row.body || '').slice(0, 200),
  }));
}

export async function check({ channel, threadId, since, home = os.homedir(), secrets: givenSecrets, fetchImpl = gwsFetch }) {
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
    process.exitCode = 0;
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
    // Gmail は既存の external-waiting.mjs がカバー
    console.error('Gmail の新着照会は external-waiting.mjs を利用してください');
    process.exitCode = 3;
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