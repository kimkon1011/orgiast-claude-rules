#!/usr/bin/env node
// 中央の未配達ウォッチドッグ（kim-PC で毎時実行・FLEET_MAIL_WATCHDOG=1 の PC だけ登録）。
// 各PCラベルについて mail-poll を dryRun で叩き（= delivered に消化しない）、
// status=new のまま 30 分以上経ったメッセージを Discord #claude-code と kim DM へ報告する。
// 2026-10-10 事故: cr-PC の受信タスクが止まり、返信4通が誰にも気付かれず消えかけた。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { createClient } from './fleet-mail.mjs';
import { notifyKim, resolveDiscordBotToken } from './notify-kim.mjs';

export const CHANNEL = '1508437329247862794';
export const STALE_MS = 30 * 60 * 1000;
export const RENOTIFY_MS = 6 * 60 * 60 * 1000;
const API = 'https://discord.com/api/v10';
const NOTIFIED_KEEP_MS = 48 * 60 * 60 * 1000;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
// fleet-pc-map.json のトップレベルラベル（_ 始まりは管理用キーなので除外）。
export function fleetLabels(pcMap) {
  return Object.entries(pcMap && typeof pcMap === 'object' && !Array.isArray(pcMap) ? pcMap : {})
    .filter(([label, entry]) => !label.startsWith('_') && entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([label, entry]) => ({ label, hostname: typeof entry.remoteName === 'string' && entry.remoteName.trim() ? entry.remoteName : label }));
}
export async function collectUndelivered(labels, poll, { now = Date.now } = {}) {
  const byId = new Map();
  for (const { label, hostname } of labels) {
    const messages = await poll({ label, hostname });
    for (const message of Array.isArray(messages) ? messages : []) {
      if (String(message.status || '') !== 'new') continue;
      const createdAt = Date.parse(message.createdAt || '');
      if (!Number.isFinite(createdAt) || createdAt > now() - STALE_MS) continue;
      // all 宛は複数ラベルで重複して返るので id で一意化する。
      if (!byId.has(message.id)) {
        byId.set(message.id, { id: String(message.id), to: label, from: String(message.from || ''), why: String(message.why || ''), createdAt: message.createdAt });
      }
    }
  }
  return [...byId.values()];
}
export function formatUndelivered(entries, now = Date.now()) {
  const lines = entries.map(entry => {
    const minutes = Math.max(1, Math.round((now - Date.parse(entry.createdAt)) / 60000));
    const why = String(entry.why || '').replace(/\s+/g, ' ').slice(0, 30);
    return `未配達: ${entry.to} 宛 ${entry.from} から「${why}」(${minutes}分経過) id=${entry.id}`;
  });
  return `⚠ fleet-mail 未配達 ${entries.length}件（status=new が30分以上）\n${lines.join('\n')}`;
}
export function notifiable(entries, state, now = Date.now()) {
  return entries.filter(entry => {
    const at = Date.parse(state?.notified?.[entry.id] || '');
    return !(Number.isFinite(at) && now - at < RENOTIFY_MS);
  });
}
export async function postToChannel(token, channelId, content, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'orgiast-fleet-mail-watchdog' },
    body: JSON.stringify({ content }), signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Discord チャンネル投稿が HTTP ${response.status}`);
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const now = deps.now ?? Date.now;
  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');
  for (const arg of argv) if (arg !== '--dry-run' && arg !== '--json') throw new Error(`unknown option: ${arg}`);
  let config = {};
  try { config = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) { err('fleet-mail-watchdog: fleet-sheet.env 未設定のためスキップ'); return 0; }
  const labels = deps.labels ?? fleetLabels(deps.pcMap ?? readJson(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'fleet-pc-map.json'), {}));
  const request = deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch });
  const poll = deps.poll ?? (async ({ label, hostname }) => (await request('mail-poll', { to: label, hostname, dryRun: true, processedIds: [] }, 60_000)).messages || []);
  const stateFile = path.join(home, '.claude', 'fleet-mail-watchdog.json');
  const state = dryRun ? { notified: {} } : (readJson(stateFile, null) || { notified: {} });
  state.notified ??= {};
  const entries = await collectUndelivered(labels, poll, { now });
  const fresh = notifiable(entries, state, now());
  const summary = { total: entries.length, notifying: fresh.length, suppressed: entries.length - fresh.length };
  if (!fresh.length) { out(json ? JSON.stringify(summary) : `未配達なし（監視対象=${entries.length}件）`); return 0; }
  const message = formatUndelivered(fresh, now());
  if (dryRun) { out(json ? JSON.stringify({ ...summary, message }) : `[DRY] ${message}`); return 0; }
  const outcomes = [];
  const token = deps.token ?? resolveDiscordBotToken(home);
  if (token) {
    try { await (deps.postChannel ?? postToChannel)(token, deps.channel ?? CHANNEL, message, deps.fetch ?? globalThis.fetch); outcomes.push('discord'); }
    catch (error) { outcomes.push(`discord-failed:${error.message}`); }
  } else outcomes.push('discord-no-token');
  try {
    const delivered = await (deps.notifyKim ?? notifyKim)(message, { home, fetchImpl: deps.fetch });
    outcomes.push(`dm:${delivered?.delivered || 'unknown'}`);
  } catch (error) { outcomes.push(`dm-failed:${error.message}`); }
  // 両方失敗したときは state を更新しない（次の毎時実行で再通知する）。
  if (outcomes.includes('discord') || outcomes.some(item => item.startsWith('dm:'))) {
    for (const entry of fresh) state.notified[entry.id] = new Date(now()).toISOString();
    const keep = new Date(now() - NOTIFIED_KEEP_MS).toISOString();
    for (const [id, at] of Object.entries(state.notified)) if (String(at) < keep) delete state.notified[id];
    writeJson(stateFile, state);
  }
  out(json ? JSON.stringify({ ...summary, outcomes }) : `${message.replace(/\r?\n/g, ' / ')} → ${outcomes.join(', ')}`);
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`fleet-mail-watchdog: ${error.message}`); process.exitCode = 1; }
}
