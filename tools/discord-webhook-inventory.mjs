#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';

const API = 'https://discord.com/api/v10';
const DEFAULT_GUILD_ID = '715211007307284530';
const REPORTER_LABEL = 'Discordサーバ(全体棚卸し)';

export function buildInventoryRows(webhooks, { channelNames = {} } = {}) {
  return (Array.isArray(webhooks) ? webhooks : []).map((webhook) => {
    const channelId = String(webhook?.channel_id ?? '');
    return {
      webhookId: String(webhook?.id ?? ''),
      name: String(webhook?.name ?? ''),
      channelId,
      channelName: String(channelNames[channelId] ?? ''),
      creator: String(webhook?.user?.username ?? ''),
      state: 'alive',
    };
  });
}

function parseArgs(argv) {
  const options = { dryRun: false, guildId: DEFAULT_GUILD_ID };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dry-run') options.dryRun = true;
    else if (argv[index] === '--guild' && argv[index + 1]) options.guildId = argv[++index];
    else throw new Error(`不明または不完全な引数: ${argv[index]}`);
  }
  return options;
}

async function discordGet(resource, botToken, fetchImpl) {
  const response = await fetchImpl(`${API}${resource}`, {
    headers: { Authorization: `Bot ${botToken}`, 'User-Agent': 'orgiast-webhook-inventory/1.0' },
  });
  if (response.status === 403) throw new Error('Botに「ウェブフックの管理」権限が必要です');
  if (!response.ok) throw new Error(`Discord API HTTP ${response.status}`);
  return response.json();
}

function printTable(rows, stdout) {
  const headings = ['webhookId', 'name', 'channelName', 'creator'];
  const widths = headings.map((heading) => Math.max(heading.length, ...rows.map((row) => String(row[heading]).length)));
  stdout.write(`${headings.map((heading, i) => heading.padEnd(widths[i])).join(' | ')}\n`);
  stdout.write(`${widths.map((width) => '-'.repeat(width)).join('-+-')}\n`);
  for (const row of rows) stdout.write(`${headings.map((heading, i) => String(row[heading]).padEnd(widths[i])).join(' | ')}\n`);
}

export async function run(argv = process.argv.slice(2), { fetchImpl = fetch, home = os.homedir(), stdout = process.stdout } = {}) {
  const options = parseArgs(argv);
  const claudeDir = path.join(home, '.claude');
  let botToken = '';
  try { botToken = (await fs.readFile(path.join(claudeDir, 'orgiast-discord-bot-token.txt'), 'utf8')).trim(); } catch {}
  if (!botToken) throw new Error('このPCにDiscord Botトークンがありません');

  const guildPath = `/guilds/${encodeURIComponent(options.guildId)}`;
  const [webhooks, channels] = await Promise.all([
    discordGet(`${guildPath}/webhooks`, botToken, fetchImpl),
    discordGet(`${guildPath}/channels`, botToken, fetchImpl),
  ]);
  const channelNames = Object.fromEntries((Array.isArray(channels) ? channels : []).map((channel) => [String(channel.id), String(channel.name ?? '')]));
  const rows = buildInventoryRows(webhooks, { channelNames });
  if (options.dryRun) {
    printTable(rows, stdout);
    return { posted: false, count: rows.length };
  }

  let envText = '';
  try { envText = await fs.readFile(path.join(claudeDir, 'fleet-sheet.env'), 'utf8'); } catch {}
  const env = parseEnvText(envText);
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) throw new Error('FLEET_SHEET_URL/TOKEN が未設定です');
  const checkedAt = new Date().toISOString().slice(0, 10);
  const response = await fetchImpl(env.FLEET_SHEET_URL, {
    method: 'POST', redirect: 'follow', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: env.FLEET_SHEET_TOKEN, kind: 'webhooks', label: REPORTER_LABEL, checkedAt, partial: true, webhooks: rows }),
  });
  let result = {};
  try { result = JSON.parse(await response.text()); } catch {}
  if (!response.ok || !result.ok) throw new Error(`Webhook台帳送信に失敗しました (HTTP ${response.status})`);
  stdout.write(`Discord webhook inventory: ${rows.length}件を台帳へ送信しました\n`);
  return { posted: true, count: rows.length };
}

if (isEntry(import.meta.url)) {
  run().catch((error) => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
