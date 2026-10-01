#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskLedger } from './task-ledger.mjs';
import { sendDiscordDm } from './feedback-nag.mjs';
import { isEntry } from './is-entry.mjs';

const HOUR = 3600000;
const ACTIVE_STATES = new Set(['依頼中', '未着手', '対応中']);
const line = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (value, length) => line(value).slice(0, length);

function hours(env, key, fallback) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} は0以上の数値を指定してください`);
  return value;
}

export function stagnationLabel(updated, now = new Date()) {
  const elapsed = now.getTime() - Date.parse(updated);
  if (!Number.isFinite(elapsed)) return '不明';
  const total = Math.max(0, Math.floor(elapsed / HOUR));
  return `${Math.floor(total / 24)}日${total % 24}時間`;
}

export function formatLedgerNag(items, now, criticalHours) {
  const header = `📋 共有タスク台帳: 動きのない依頼 ${items.length}件`;
  const render = (row, compact = false) => {
    const critical = now.getTime() - Date.parse(row.最終更新) > criticalHours * HOUR ? '⚠️ 長期停滞 ' : '';
    return `- ${critical}[${clip(row.taskId, compact ? 40 : 200)}] ${clip(row.件名, compact ? 50 : 500)}\n  担当PC: ${clip(row.担当PC, compact ? 30 : 200)} / 状態: ${line(row.状態)} / 停滞: ${stagnationLabel(row.最終更新, now)}\n  次アクション: ${clip(row.次アクション, 120)}\n  ${line(row.成果物リンク)}`;
  };
  let shown = items;
  let content = [header, ...shown.map((row) => render(row))].join('\n');
  if (content.length > 2000) {
    shown = items.slice(0, 5);
    const footer = shown.length < items.length ? `\n他${items.length - shown.length}件` : '';
    const budget = Math.floor((2000 - header.length - footer.length - shown.length) / shown.length);
    // 各行にも上限を設け、長大なリンクや件名でもDiscordの制限を守る。
    content = [header, ...shown.map((row) => {
      const text = render(row, true);
      return text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
    })].join('\n') + footer;
  }
  return { content, shown };
}

const defaultIo = {
  read: (file) => fs.readFileSync(file, 'utf8'),
  write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); },
  stdout: (text) => process.stdout.write(`${text}\n`),
};

export async function runLedgerNag({
  args = process.argv.slice(2),
  home = process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir(),
  env = process.env, now = new Date(), io = defaultIo, list = runTaskLedger, sendDm = sendDiscordDm,
} = {}) {
  const warnHours = hours(env, 'LEDGER_NAG_WARN_HOURS', 24);
  const criticalHours = hours(env, 'LEDGER_NAG_CRITICAL_HOURS', 72);
  const cooldownHours = hours(env, 'LEDGER_NAG_COOLDOWN_HOURS', 24);
  const result = await list({ command: 'list' }, { homeDir: home });
  if (!result?.ok || !Array.isArray(result.rows)) throw new Error('台帳の応答が不正です');
  const stateFile = path.join(home, '.claude', 'ledger-nag-state.json');
  let state = {};
  try { state = JSON.parse(io.read(stateFile)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('通知履歴が不正です');
  const seen = new Set();
  const items = result.rows.filter((row) => {
    if (!row.taskId || seen.has(row.taskId) || !ACTIVE_STATES.has(row.状態)) return false;
    seen.add(row.taskId);
    const elapsed = now.getTime() - Date.parse(row.最終更新);
    const sinceNotified = now.getTime() - Date.parse(Object.hasOwn(state, row.taskId) ? state[row.taskId] : '');
    return elapsed > warnHours * HOUR && !(sinceNotified < cooldownHours * HOUR);
  }).sort((a, b) => Date.parse(a.最終更新) - Date.parse(b.最終更新));
  if (!items.length) { io.stdout(JSON.stringify({ ok: true, notified: 0 })); return 0; }
  const { content, shown } = formatLedgerNag(items, now, criticalHours);
  if (args.includes('--dry-run')) { io.stdout(content); return 0; }
  const token = env.DISCORD_BOT_TOKEN?.trim() || io.read(path.join(home, '.claude', 'orgiast-discord-bot-token.txt')).trim();
  if (!token) throw new Error('Discord Bot トークンが見つかりません');
  await sendDm({ token, userId: '715210673642012733', content });
  for (const row of shown) Object.defineProperty(state, row.taskId, { value: now.toISOString(), enumerable: true, configurable: true, writable: true });
  io.write(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  io.stdout(JSON.stringify({ ok: true, notified: shown.length }));
  return 0;
}

if (isEntry(import.meta.url)) {
  runLedgerNag().catch((error) => { console.error(`ledger-stale-nag: ${error.message}`); process.exitCode = 1; });
}
