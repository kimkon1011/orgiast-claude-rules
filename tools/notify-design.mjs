#!/usr/bin/env node
// notify-design.mjs  — C4 実運用化デザイン完了を kim の Discord DM へ通知
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const API = 'https://discord.com/api/v10';
const KIM_DISCORD_USER_ID = '715210673642012733';

function resolveDiscordBotToken(home) {
  return process.env.DISCORD_BOT_TOKEN?.trim()
    || fs.readFileSync(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), 'utf8').trim();
}

async function sendDm(userId, content, token) {
  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'orgiast-design-notify/1.0',
  };
  const dm = await fetch(`${API}/users/@me/channels`, {
    method: 'POST', headers,
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!dm.ok) throw new Error(`DMチャンネル作成 HTTP ${dm.status}`);
  const channelId = (await dm.json()).id;
  const sent = await fetch(`${API}/channels/${channelId}/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ content }),
  });
  if (!sent.ok) throw new Error(`DM送信 HTTP ${sent.status}`);
  return (await sent.json()).id;
}

async function main() {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const token = resolveDiscordBotToken(home);
  if (!token) { console.error('Discord Bot トークンが見つかりません'); process.exit(1); }

  const content = [
    '## 📋 C4実運用化デザインを作成しました',
    '',
    'クォータスイープに _c4_check.mjs（fallback_chain_timeout 監視）を統合する包括的デザインを確定しました。',
    '',
    '**5つの未確定判断を解決**:',
    '① 観測者 → 巡回型（スイープループ統合）',
    '② 観測方法 → _c4_check.mjs ローカル実行（GAS不要）',
    '③ 通知先 → Discord DM（notify-kim 経路）',
    '④ 閾値 → 24h fallback+timeout < 2（現状0件）',
    '⑤ 自動対処 → 通知＋next-session.md 起票（main rescue は別案件）',
    '',
    '**現状（実測 08:28 JST）**:',
    '- fallback_chain_timeout finding: **0件**（PR #1237 の修正が継続）',
    '- 24h timeout: **0件**',
    '- C4 failure は delegation-health.json の generatedAt が 03:25 エポック前のため（次回スイープで解消見込み）',
    '',
    '**デザイン文書**: `quota-sweep-repo/c4-operationalization-design.md`',
    '',
    '**次のアクション**: このデザインをレビューし、承認・修正指示をお願いします。',
    '',
    `> 送信時刻: 2026-10-30T08:28 JST`,
    `> この通知は自動生成です`,
  ].join('\n');

  const messageId = await sendDm(KIM_DISCORD_USER_ID, content, token);
  console.log(`通知送信完了 messageId=${messageId}`);
}

if (isEntry(import.meta.url)) main().catch(e => { console.error('FATAL:', e.message); process.exit(2); });