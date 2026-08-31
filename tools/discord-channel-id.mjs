#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { buildDiscordChannelRows } from './discord-channel-ledger.mjs';

const GUILD_ID = '715211007307284530';

export function formatChannelLines(rows) {
  const values = Array.isArray(rows) ? rows : [];
  const lines = ['ID / 名前 / カテゴリ / 用途'];
  for (const row of values) lines.push(`${row?.id || ''} / ${row?.name || ''} / ${row?.category || ''} / ${row?.purpose || ''}`);
  return lines.join('\n');
}

export function pickResult(rows, { json = false, query = '' } = {}) {
  const values = Array.isArray(rows) ? rows : [];
  if (json) return { exitCode: 0, stdout: `${JSON.stringify({ query, count: values.length, rows: values })}\n`, stderr: '' };
  if (values.length === 1) return { exitCode: 0, stdout: `${values[0].id}\n`, stderr: '' };
  if (values.length > 1) return { exitCode: 1, stdout: '', stderr: `候補が複数あります。名前で選んでください。\n${formatChannelLines(values)}\n` };
  return { exitCode: 1, stdout: '', stderr: '一致するDiscordチャンネルがありません。\n' };
}

function parseArgs(args) {
  const options = { exact: false, json: false, all: false, refresh: false, limit: 50, query: '' };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--exact') options.exact = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--limit') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error('--limit は 1〜200 の整数で指定してください');
      options.limit = value;
    } else if (arg.startsWith('--')) throw new Error(`不明なオプション: ${arg}`);
    else positional.push(arg);
  }
  options.query = positional.join(' ');
  if (options.all) { options.query = ''; options.limit = 200; }
  if (!options.all && !options.query) throw new Error('チャンネル名の一部を指定してください（全件は --all）');
  return options;
}

async function postLookup(url, token, options) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'follow', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, kind: 'discord-lookup', query: options.query, exact: options.exact, limit: options.limit }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`台帳 API HTTP ${response.status}`);
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('台帳 API の応答がJSONではありません'); }
  if (!result.ok) throw new Error(`台帳 API が検索を拒否しました: ${result.error || 'unknown error'}`);
  return Array.isArray(result.rows) ? result.rows : [];
}

async function directDiscordLookup(query, exact, limit, token) {
  const response = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, { headers: { Authorization: `Bot ${token}` } });
  if (!response.ok) throw new Error(`Discord API HTTP ${response.status}`);
  const normalized = String(query).toLowerCase().replace(/[ \u3000]/g, '');
  const idQuery = /^\d{19}$/.test(String(query).trim());
  return buildDiscordChannelRows(await response.json(), GUILD_ID).filter((row) => {
    if (idQuery) return row.id === String(query).trim();
    const name = row.name.toLowerCase().replace(/[ \u3000]/g, '');
    return exact ? name === normalized : name.includes(normalized);
  }).slice(0, limit).map((row) => ({ ...row, purpose: '', owner: '', note: '', state: 'あり', checkedAt: '' }));
}

function nearbyRows(rows, query) {
  const chars = [...new Set(String(query).toLowerCase().replace(/[ \u3000]/g, ''))];
  return rows.map((row) => {
    const name = String(row.name || '').toLowerCase().replace(/[ \u3000]/g, '');
    const score = chars.reduce((total, char) => total + (name.includes(char) ? 1 : 0), 0);
    return { row, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map((item) => item.row);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.ORGIAST_HOME || os.homedir();
  const claudeDir = path.join(home, '.claude');
  const env = parseEnvText(fs.readFileSync(path.join(claudeDir, 'fleet-sheet.env'), 'utf8'));
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) throw new Error('~/.claude/fleet-sheet.env に FLEET_SHEET_URL/TOKEN がありません');
  const tokenFile = path.join(claudeDir, 'orgiast-discord-bot-token.txt');
  let botToken = '';
  try { botToken = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}

  if (options.refresh) {
    if (!botToken) console.error('このPCにはBotトークンが無いので台帳の値をそのまま使います。');
    else {
      const ledger = fileURLToPath(new URL('./discord-channel-ledger.mjs', import.meta.url));
      const refreshed = spawnSync(process.execPath, [ledger], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } });
      if (refreshed.status !== 0) throw new Error(`Discordチャンネル台帳の更新に失敗しました: ${String(refreshed.stderr || '').trim() || `終了コード${refreshed.status}`}`);
      console.error('Discordチャンネル台帳を更新しました。');
    }
  }

  let rows = await postLookup(env.FLEET_SHEET_URL, env.FLEET_SHEET_TOKEN, options);
  if (!rows.length && botToken) rows = await directDiscordLookup(options.query, options.exact, options.limit, botToken);
  if (!rows.length && !options.json) {
    const allRows = await postLookup(env.FLEET_SHEET_URL, env.FLEET_SHEET_TOKEN, { query: '', exact: false, limit: 200 });
    const nearby = nearbyRows(allRows, options.query);
    if (nearby.length) console.error(`近い候補:\n${formatChannelLines(nearby)}`);
  }
  const result = pickResult(rows, options);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (isEntry(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
