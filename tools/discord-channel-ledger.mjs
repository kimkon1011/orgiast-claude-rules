#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const TYPE_NAMES = { 0: 'テキスト', 2: 'ボイス', 4: 'カテゴリ', 5: 'アナウンス', 13: 'ステージ', 15: 'フォーラム', 16: 'メディア' };

export function buildDiscordChannelRows(channels, guildId, checkedAt) {
  void checkedAt;
  const source = Array.isArray(channels) ? channels : [];
  const categories = new Map(source.filter((channel) => channel.type === 4).map((channel) => [String(channel.id), channel]));
  return source.map((channel) => {
    const id = String(channel.id);
    const parentId = channel.parent_id == null ? '' : String(channel.parent_id);
    const category = channel.type === 4 ? '' : String(categories.get(parentId)?.name || '');
    return {
      id, name: String(channel.name || ''), category,
      type: TYPE_NAMES[channel.type] || `type:${channel.type}`,
      parentId, url: `https://discord.com/channels/${guildId}/${id}`,
      _position: Number.isFinite(channel.position) ? channel.position : 0,
      _categoryRow: channel.type === 4,
    };
  }).sort((a, b) => {
    const aGroup = a._categoryRow ? a.name : a.category;
    const bGroup = b._categoryRow ? b.name : b.category;
    const aUnparented = !a._categoryRow && !a.category;
    const bUnparented = !b._categoryRow && !b.category;
    if (aUnparented !== bUnparented) return aUnparented ? -1 : 1;
    const groupOrder = aGroup.localeCompare(bGroup, 'ja');
    if (groupOrder) return groupOrder;
    if (a._categoryRow !== b._categoryRow) return a._categoryRow ? -1 : 1;
    return a._position - b._position || a.name.localeCompare(b.name, 'ja');
  }).map(({ _position, _categoryRow, ...row }) => row);
}

function jstDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function fetchChannels(guildId, token) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/channels`, { headers: { Authorization: `Bot ${token}` } });
    if (response.status === 200) return response.json();
    const text = await response.text();
    let reason = text.slice(0, 300);
    let retryAfter = 0;
    try { const body = JSON.parse(text); reason = body.message || reason; retryAfter = Number(body.retry_after || 0); } catch {}
    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, retryAfter) * 1000));
      continue;
    }
    throw new Error(`Discord API HTTP ${response.status}: ${reason}`);
  }
  throw new Error('Discord API retry limit reached');
}

async function main() {
  const args = process.argv.slice(2);
  const guildIndex = args.indexOf('--guild');
  const guildId = guildIndex >= 0 && args[guildIndex + 1] ? args[guildIndex + 1] : '715211007307284530';
  const dryRun = args.includes('--dry-run');
  const home = process.env.ORGIAST_HOME || os.homedir();
  const claudeDir = path.join(home, '.claude');
  const botToken = fs.readFileSync(path.join(claudeDir, 'orgiast-discord-bot-token.txt'), 'utf8').trim();
  if (!botToken) throw new Error('Discord Bot token is empty');
  const checkedAt = jstDate();
  const channels = buildDiscordChannelRows(await fetchChannels(guildId, botToken), guildId, checkedAt);
  if (dryRun) {
    console.log(JSON.stringify({ checkedAt, channels }, null, 2));
    return;
  }
  const env = parseEnvText(fs.readFileSync(path.join(claudeDir, 'fleet-sheet.env'), 'utf8'));
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) throw new Error('FLEET_SHEET_URL/TOKEN is not configured');
  const response = await fetch(env.FLEET_SHEET_URL, {
    method: 'POST', redirect: 'follow', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: env.FLEET_SHEET_TOKEN, kind: 'discord-channels', checkedAt, channels }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`fleet sheet HTTP ${response.status}`);
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('fleet sheet returned invalid JSON'); }
  if (!result.ok) throw new Error(`fleet sheet rejected request: ${result.error || 'unknown error'}`);
  console.log(JSON.stringify({ ok: true, updated: result.updated, appended: result.appended, missing: result.missing || [] }));
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
