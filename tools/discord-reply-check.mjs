#!/usr/bin/env node
// Discord REST API 経由でチャンネルの返信（非Botメッセージ）を確認する。
// MCP コネクタ承認不要。Administrator Bot トークンを使用。
// 使い方: node tools/discord-reply-check.mjs <channelId> [afterMessageId]
//  --help で詳細表示
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const API = 'https://discord.com/api/v10';
const BOT_IDS = ['1545348138758574162', '1529301668607426610', '1511684767546871818'];

export function getToken(home = os.homedir()) {
  const file = path.join(home, '.claude', 'orgiast-discord-bot-token.txt');
  return fs.readFileSync(file, 'utf8').trim();
}

export function snowflakeTime(id) {
  return new Date(Number(BigInt(id) >> 22n) + 1420070400000);
}

export async function listMessages(channelId, options = {}) {
  const { after, limit = 50, excludeBot = true } = options;
  const url = new URL(`${API}/channels/${channelId}/messages`);
  url.searchParams.set('limit', String(Math.min(limit, 100)));
  if (after) url.searchParams.set('after', String(after));

  const token = getToken();
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://orgiast.jp, 1.0)' }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Discord API ${res.status}: ${err.message || res.statusText}`);
  }

  const msgs = await res.json();
  if (!Array.isArray(msgs)) throw new Error(`Unexpected response: ${JSON.stringify(msgs).slice(0, 200)}`);

  const filtered = msgs.map(m => ({
    id: m.id,
    timestamp: snowflakeTime(m.id).toISOString(),
    author: { id: m.author.id, name: m.author.username },
    isBot: BOT_IDS.includes(m.author.id),
    content: (m.content || '').slice(0, 500),
    hasAttachments: (m.attachments || []).length > 0,
    referencedMessage: m.referenced_message?.id || null,
  }));

  const human = filtered.filter(m => !m.isBot);
  const bot = filtered.filter(m => m.isBot);

  return { total: filtered.length, human: human.length, bot: bot.length, messages: excludeBot ? human : filtered };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    console.log(`
discord-reply-check.mjs — Discordチャンネルの返信確認（REST API / MCP不要）

使い方:
  node tools/discord-reply-check.mjs <channelId> [afterMessageId] [--all]
  node tools/discord-reply-check.mjs <channelId> --after <messageId> [--all]

引数:
  channelId       DiscordチャンネルID
  afterMessageId  このメッセージIDより後のメッセージのみ取得（省略時: 最新50件）
  --all           Botメッセージも含めて表示（省略時: 非Botのみ）

出力: JSON（total/human/bot/messages[]）
`);
    process.exit(0);
  }

  const channelId = args[0];
  const afterIdx = args.indexOf('--after');
  const after = afterIdx >= 0 ? args[afterIdx + 1] : (args[1] && !args[1].startsWith('--') ? args[1] : undefined);
  const showAll = args.includes('--all');

  try {
    const result = await listMessages(channelId, { after, excludeBot: !showAll });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

if (isEntry(import.meta.url)) main();