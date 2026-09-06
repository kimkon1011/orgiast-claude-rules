#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const DISCORD_API = 'https://discord.com/api/v10';
const DEFAULT_USER_ID = '715210673642012733';
const DONE_STATES = new Set(['done', '完了', '対応済', '却下']);

function userHome() {
  return process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
}

function readText(file, io) { try { return io.read(file); } catch { return ''; } }
function clipped(value, length, fallback = '') { return (String(value ?? '').replace(/\s+/g, ' ').trim() || fallback).slice(0, length); }

export function pendingItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => !DONE_STATES.has(String(item?.status ?? '').trim().toLowerCase()));
}

export function elapsedLabel(ts, now = new Date()) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/.exec(String(ts ?? '').trim());
  if (!match) return '経過不明';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return '経過不明';
  return `経過 ${Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86400000))} 日`;
}

export function formatNag(items, sheetUrl, now = new Date()) {
  const lines = [`🐛 未対応の不具合・要望 ${items.length} 件`];
  for (const item of items.slice(0, 15)) {
    const reply = String(item?.note ?? '').trim() ? '返答済・未完了' : '未返答';
    lines.push(`・[${clipped(item?.kind, 20, '不具合')}/${reply}] ${clipped(item?.title, 70, '(無題)')} … ${elapsedLabel(item?.ts, now)} / 送信元: ${clipped(item?.source, 50, '不明')}`);
  }
  if (items.length > 15) lines.push(`ほか ${items.length - 15} 件`);
  if (sheetUrl) lines.push(String(sheetUrl));
  return lines.join('\n').slice(0, 1900);
}

export async function sendDiscordDm({ token, userId, content, fetchImpl = fetch }) {
  const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
  const channelResponse = await fetchImpl(`${DISCORD_API}/users/@me/channels`, { method: 'POST', headers, body: JSON.stringify({ recipient_id: userId }) });
  if (!channelResponse.ok) throw new Error(`Discord DM channel creation failed (${channelResponse.status})`);
  const channel = JSON.parse(await channelResponse.text());
  if (!channel?.id) throw new Error('Discord DM channel response has no id');
  const messageResponse = await fetchImpl(`${DISCORD_API}/channels/${channel.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ content }) });
  if (!messageResponse.ok) throw new Error(`Discord DM send failed (${messageResponse.status})`);
}

const defaultIo = { read: (file) => fs.readFileSync(file, 'utf8'), stdout: (text) => process.stdout.write(`${text}\n`), stderr: (text) => console.error(text), now: () => new Date() };

export async function runNag({ args = process.argv.slice(2), home = userHome(), io = defaultIo, fetchImpl = fetch, sendDm = sendDiscordDm } = {}) {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const output = (value) => io.stdout(json ? JSON.stringify(value) : value);
  try {
    const apiEnv = parseEnvText(readText(path.join(home, '.claude', 'booth-feedback.env'), io));
    if (!apiEnv.BOOTH_FEEDBACK_URL || !apiEnv.BOOTH_FEEDBACK_TOKEN) throw new Error('BOOTH_FEEDBACK_URL / BOOTH_FEEDBACK_TOKEN が見つかりません');
    const url = new URL(apiEnv.BOOTH_FEEDBACK_URL);
    url.searchParams.set('token', apiEnv.BOOTH_FEEDBACK_TOKEN);
    url.searchParams.set('action', 'feedback');
    const response = await fetchImpl(url.toString());
    const text = await response.text();
    if (!response.ok) throw new Error(`feedback API failed (${response.status})`);
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`feedback API returned invalid JSON: ${text.slice(0, 200)}`); }
    if (!payload?.ok) throw new Error(`feedback API error: ${payload?.error || 'unknown error'}`);
    const items = pendingItems(payload.items);
    if (!items.length) {
      if (json) output({ ok: true, count: 0, sent: false, items: [] });
      return 0;
    }
    const content = formatNag(items, payload.sheetUrl, io.now());
    let sent = false;
    if (!dryRun) {
      const nagEnv = parseEnvText(readText(path.join(home, '.claude', 'feedback-nag.env'), io));
      const userId = nagEnv.FEEDBACK_NAG_DISCORD_USER_ID || DEFAULT_USER_ID;
      const token = process.env.DISCORD_BOT_TOKEN?.trim() || readText(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'), io).trim();
      if (!token) throw new Error('Discord Bot トークンが見つかりません');
      await sendDm({ token, userId, content, fetchImpl });
      sent = true;
    }
    output(json ? { ok: true, count: items.length, sent, items } : content);
    return 0;
  } catch (error) {
    const message = error?.message || String(error);
    io.stderr(`feedback-nag: ${message}`);
    if (json) output({ ok: false, error: message });
    return 0;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runNag();
