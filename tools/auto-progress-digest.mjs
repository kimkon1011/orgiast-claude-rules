#!/usr/bin/env node
// 各PCのローカル台帳から、完了・進行中・停滞/再開・期限超過を 持ち主の DM へ定期報告する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { notifyOwner } from './notify-owner.mjs';
import { ledgerFile, readLedger, latestOpenPromises, rowKey, isUnattendedRow } from './auto-progress-ledger.mjs';
import { MAX_RESUMES } from './auto-progress-watch.mjs';
export { isUnattendedRow } from './auto-progress-ledger.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

export const WINDOW_MS = 24 * 3600 * 1000;
const MAX_MESSAGE = 2000;
const stateFile = (home) => path.join(home, '.claude', 'state', 'auto-progress-digest.json');
const logFile = (home) => path.join(home, '.claude', 'logs', 'auto-progress-digest.summary.log');

function readState(home) { try { const v = JSON.parse(fs.readFileSync(stateFile(home), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function writeState(home, value) { const file = stateFile(home); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value)}\n`); }
function appendLog(home, value, io = {}) {
  try { const file = logFile(home); (io.mkdirSync ?? fs.mkdirSync)(path.dirname(file), { recursive: true }); (io.appendFileSync ?? fs.appendFileSync)(file, `${new Date(value.at).toISOString()} ${JSON.stringify(value)}\n`); }
  catch (error) { (io.stderr ?? console.error)(`auto-progress-digest: summary log failed: ${error?.message ?? error}`); }
}

const rowTime = (row) => Date.parse(row.doneAt || row.lastCheckedAt || row.resumedAt || row.ts);
function deadlinePassed(row, now) {
  const explicit = Date.parse(row.deadlineAt || row.dueAt || '');
  if (Number.isFinite(explicit)) return explicit <= now;
  const match = String(row.promise || '').match(/20\d{2}[-\/]\d{1,2}[-\/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?/);
  if (!match) return false;
  const parsed = Date.parse(match[0].replaceAll('/', '-'));
  return Number.isFinite(parsed) && parsed <= now;
}

export function selectRows(rows, now = Date.now(), since = now - WINDOW_MS) {
  const ledger = Array.isArray(rows) ? rows : [];
  const active = new Set(latestOpenPromises(ledger));
  return ledger.filter((row) => {
    if (row.status === 'done') return Number.isFinite(Date.parse(row.doneAt)) && Date.parse(row.doneAt) > since;
    return active.has(row);
  }).sort((a, b) => rowTime(a) - rowTime(b));
}

export const verdictOf = (row, now) => row.status === 'done' ? 'done' : row.status === 'waiting_user' ? 'waiting_user' : row.status === 'resumed' ? 'resumed' : row.verdict || (row.status === 'stalled' ? 'stalled' : deadlinePassed(row, now) ? 'open/期限超過' : row.lastCheckedAt ? 'in_progress' : 'open');
export const MAX_ITEMS = 10;
const kimAction = row => {
  const value = String(row.nextKim || '').trim();
  return /^(?:(?:特に)?なし|無し|ナシ|(?:対応(?:は)?)?不要(?:です)?|(?:特に)?ありません|none|n\/a|[-—–－ー―])(?:[（(].*[）)])?[。．]?$/i.test(value) || !value ? 'なし' : value;
};
// 台帳の自由文に埋め込まれた機械用の値は、主語を消さず役割の名前に置き換える。
function readable(value, row, limit) {
  let text = String(value || '').replace(/\s+/g, ' ');
  for (const [key, replacement] of [['pc', 'このパソコン'], ['sessionId', 'この作業']]) {
    if (row[key]) text = text.split(String(row[key])).join(replacement);
  }
  text = text.replace(/`[^`]*`/g, '作業記録').replace(/(?:~\/|[A-Za-z]:[\\/]|(?<![A-Za-z0-9])\/(?=[A-Za-z_.]))[A-Za-z0-9_.\\/-]+/g, '作業記録');
  return text.replace(/\b(?:gh|git|node|npm|npx|pwsh|powershell|bash|curl)(?:[ \t]+[\x21-\x7E]+)+/g, '必要な操作')
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '予定の日時')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '記録番号')
    .replace(/\bDESKTOP-[a-z0-9]+\b|\b[a-z0-9]+-PC\b/gi, '別のパソコン')
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/g, '対象の処理')
    .replace(/[A-Za-z][A-Za-z0-9_.=/-]*/g, word => ({
      Claude: '自動処理', Discord: '連絡先', Drive: '共有資料', GAS: '連携処理', TODO: '未完了の作業',
      DM: 'メッセージ', PR: '変更案', CI: '自動検証', SLA: '配達期限', SUCCESS: '成功', FAILED: '失敗', MERGED: '反映済み',
      automerge: '自動で反映', resolve: '解決', push: '送信', kim: 'kim', OK: '了承', A: 'A', B: 'B',
    }[word] || word)).slice(0, limit);
}
function itemText(row, now) {
  const verdict = verdictOf(row, now), attempts = Number(row.resumeCount) || 0;
  const states = { done: '終わりました', in_progress: '進んでいます', open: 'まだ始まっていません', stalled: '止まっています', resumed: `自動で再開しました（${attempts} 回目）`, waiting_user: 'kim の判断待ち', 'open/期限超過': '期限を過ぎています' };
  const next = verdict === 'done' ? 'なし（これで終わりです）' : verdict === 'waiting_user' ? 'kim の返事を待っています' : attempts >= MAX_RESUMES ? '自動再開の上限なので、7 日で自動的に閉じます' : verdict === 'stalled' ? `2 時間後の巡回で自動で再開します（${attempts + 1} 回目）` : '次の巡回で確認します';
  const reason = readable(row.reason || row.resumeOutcome, row, 40);
  return `・${readable(row.purpose || row.sessionPurpose || row.objective || row.promise || '約束した作業', row, 60)}\n  今: ${states[verdict] || states.open}${reason ? `（${reason}）` : ''}\n  次に自動でやること: ${next} ／ kim がすること: ${readable(kimAction(row), row, 60)}`;
}
export function formatDigest(rows, now = Date.now(), label = '', { allRows = rows, unattended = 0, remaining = 0 } = {}) {
  if (!rows.length) return '';
  const count = state => allRows.filter(row => verdictOf(row, now) === state).length;
  const pending = latestOpenPromises(allRows);
  const ages = pending.map(row => Date.parse(row.ts)).filter(Number.isFinite);
  const oldest = ages.length ? Math.max(0, Math.floor((now - Math.min(...ages)) / WINDOW_MS)) : 0;
  return `自動進行 まとめ: 進んでいる ${count('in_progress')} / 止まっている ${count('stalled')}（自動で再開中 ${count('resumed')}）/ kim の判断待ち ${count('waiting_user')} / 終わった ${count('done')} ／ 無人処理の約束 ${unattended} 件は数だけ ／ 未処理 ${pending.length} 件・最古 ${oldest} 日前\n${rows.map(row => itemText(row, now)).join('\n')}${remaining ? `\n…ほか ${remaining} 件（次回以降に）` : ''}`;
}

export function splitMessages(text, limit = MAX_MESSAGE) {
  const lines = String(text).split('\n'); const chunks = []; let current = '';
  for (const line of lines) {
    if (line.length > limit) { if (current) chunks.push(current); chunks.push(...line.match(new RegExp(`.{1,${limit}}`, 'gs'))); current = ''; continue; }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) { chunks.push(current); current = line; } else current = next;
  }
  if (current) chunks.push(current); return chunks;
}

function defaultSlot(now) { return new Date(now).getHours() < 12 ? '朝' : '夕'; }
export async function run({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, slot, io = {} } = {}) {
  const label = io.label ?? resolveFleetLabel(home);
  const state = (io.readState ?? readState)(home);
  // Keep the initial done cutoff: advancing it would lose unsent completions beyond the cap.
  const since = state.doneSince ?? (Number.isFinite(Date.parse(state.lastSuccessAt)) ? Date.parse(state.lastSuccessAt) : now - WINDOW_MS);
  const all = selectRows((io.readLedger ?? readLedger)(ledgerFile(home)), now, since);
  const lastVerdicts = { ...(state.lastVerdicts || {}) }, lastKim = { ...(state.lastKim || {}) };
  const changed = all.filter(row => !isUnattendedRow(row, home) &&
    (lastVerdicts[rowKey(row)] !== verdictOf(row, now) || (kimAction(row) !== 'なし' && lastKim[rowKey(row)] !== kimAction(row))));
  if (!changed.length) return { sent: false, count: 0 };
  const groups = new Map();
  for (const row of changed.slice(0, MAX_ITEMS)) {
    const owner = row.owner || '';
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(row);
  }
  const deliveries = [...groups].map(([owner, candidates]) => {
    const owned = all.filter(row => (row.owner || '') === owner);
    const options = { allRows: owned.filter(row => !isUnattendedRow(row, home)), unattended: owned.filter(row => isUnattendedRow(row, home)).length };
    const total = changed.filter(row => (row.owner || '') === owner).length;
    let rows = candidates;
    let message;
    do {
      message = formatDigest(rows, now, label, { ...options, remaining: total - rows.length });
      if (message.length <= MAX_MESSAGE || rows.length === 1) break;
      rows = rows.slice(0, -1);
    } while (rows.length);
    return { owner, rows, message };
  });
  const messages = deliveries.map(({ message }) => message), text = messages.join('\n');
  const count = deliveries.reduce((n, delivery) => n + delivery.rows.length, 0);
  const digest = createHash('sha256').update(JSON.stringify(deliveries.map(({ owner, message }) => [owner, message]))).digest('hex').slice(0, 16);
  const slotKey = `${new Date(now).toLocaleDateString('sv-SE')}|${slot || defaultSlot(now)}|${digest}`;
  if ((state.sentKeys || []).includes(slotKey)) return { skipped: 'already-sent', sent: false, count };
  if (dryRun) return { sent: false, count, text, messages };
  let error = '';
  for (const { owner, rows, message } of deliveries) {
    let result;
    try {
      result = io.notify ? await io.notify(message, { home, webhookFallback: false, owner }) : await (io.notifyOwner ?? notifyOwner)(owner, message, { home });
    } catch (cause) { result = { reason: cause?.message || String(cause) }; }
    if (result?.delivered !== 'dm') { error = result?.reason || 'DM not delivered'; break; }
    for (const row of rows) { lastVerdicts[rowKey(row)] = verdictOf(row, now); lastKim[rowKey(row)] = kimAction(row); }
    // Persist each successful owner delivery so another owner's failure cannot duplicate it.
    (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim });
  }
  if (error) {
    (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim, lastFailure: { at: new Date(now).toISOString(), slot: slotKey, error } });
    appendLog(home, { at: now, label, slot: slotKey, sent: false, count, error }, io);
    return { sent: false, count, error };
  }
  const next = { ...state, doneSince: since, lastVerdicts, lastKim, lastSuccessAt: new Date(now).toISOString(), sentKeys: [...(state.sentKeys || []), slotKey].slice(-60) };
  (io.writeState ?? writeState)(home, next);
  appendLog(home, { at: now, label, slot: slotKey, sent: true, count, parts: messages.length }, io);
  return { sent: true, count, parts: messages.length };
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await run({ dryRun: process.argv.includes('--dry-run') }))); }
  catch (error) { console.error(String(error?.message ?? error)); }
  process.exitCode = 0;
}
