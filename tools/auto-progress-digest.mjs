#!/usr/bin/env node
// 各PCのローカル台帳から、完了・進行中・停滞/再開・期限超過を 持ち主の DM へ定期報告する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { notifyOwner, resolveOwner } from './notify-owner.mjs';
import { ledgerFile, readLedger, latestOpenPromises, rowKey, isUnattendedRow, isNoopPromise, MAX_RESUMES } from './auto-progress-ledger.mjs';
export { isUnattendedRow } from './auto-progress-ledger.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';

export const WINDOW_MS = 24 * 3600 * 1000;
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
    if (isNoopPromise(row.promise)) return false;
    if (row.status === 'done') return Number.isFinite(Date.parse(row.doneAt)) && Date.parse(row.doneAt) > since;
    return active.has(row);
  }).sort((a, b) => rowTime(a) - rowTime(b));
}

export const verdictOf = (row, now = Date.now()) => row.status === 'done' ? 'done' : row.status === 'waiting_user' ? 'waiting_user' : row.status === 'resumed' ? 'resumed' : row.verdict || (row.status === 'stalled' ? 'stalled' : deadlinePassed(row, now) ? 'open/期限超過' : row.lastCheckedAt ? 'in_progress' : 'open');
export const MAX_ITEMS = 10;
const kimAction = row => {
  const value = String(row.nextKim || '').trim();
  const action = /^(?:(?:特に)?なし|無し|ナシ|(?:対応(?:は)?)?不要(?:です)?|(?:特に)?ありません|none|n\/a|[-—–－ー―])(?:[（(].*[）)])?[。．]?$/i.test(value) || !value ? 'なし' : value;
  return action === 'なし' && verdictOf(row) === 'waiting_user'
    ? String(row.reason || row.resumeOutcome || '判断内容を確認してください').replace(/^needs_user:\s*/, '').slice(0, 80) : action;
};
export function needsDm(row, now = Date.now()) {
  if (isNoopPromise(row.promise)) return false;
  const verdict = verdictOf(row, now);
  return kimAction(row) !== 'なし' || ['waiting_user', 'done', 'open/期限超過'].includes(verdict) ||
    (verdict === 'stalled' && Number(row.resumeCount) >= MAX_RESUMES);
}
function readable(value, row, limit) {
  let text = String(value || '');
  for (const [key, replacement] of [['pc', 'このパソコン'], ['sessionId', 'この作業']]) {
    if (row[key]) text = text.split(String(row[key])).join(replacement);
  }
  return text.replace(/\s+/g, ' ').slice(0, limit);
}
export function formatDigest(rows, now = Date.now(), label = '', { allRows = rows, unattended = 0 } = {}) {
  allRows = allRows.filter(row => !isNoopPromise(row.promise));
  if (!rows.filter(row => !isNoopPromise(row.promise)).length) return '';
  const done = allRows.filter(row => row.status === 'done');
  const waiting = allRows.filter(row => row.status !== 'done' && kimAction(row) !== 'なし');
  const unmet = allRows.filter(row => row.status !== 'done' && !waiting.includes(row) && row.check && ['unmet', 'check_error'].includes(verdictOf(row, now)));
  const unchecked = allRows.filter(row => !row.check && row.status !== 'done' && !waiting.includes(row));
  const lines = [`自動進行: 完了 ${done.length} / 未達（次の手） ${unmet.length} / kim の操作待ち ${waiting.length}`];
  for (const [title, items] of [['完了', done], ['未達', unmet], ['kim の操作待ち', waiting]]) {
    for (const row of items.slice(0, 2)) {
      const detail = title === '未達' ? `Claude の次の手: ${row.nextClaude || '実行ログと受け口を調査・修正し再確認'}` : title === 'kim の操作待ち' ? `kim がすること: ${kimAction(row)}` : row.checkText || row.reason || '完了を記録';
      lines.push(`・${title}: ${readable(row.label || row.promise || '約束した作業', row, 60)} — ${readable(detail, row, 100)}`);
    }
  }
  lines.push(`確認手段なし: ${unchecked.length}件（check 未登録）`);
  if (unattended) lines.push(`無人処理の約束 ${unattended} 件は数だけ`);
  return lines.join('\n');
}

function defaultSlot(now) { return new Date(now).getHours() < 12 ? '朝' : '夕'; }
export async function run({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, slot, io = {} } = {}) {
  const label = io.label ?? resolveFleetLabel(home);
  const state = (io.readState ?? readState)(home);
  // Preserve the cutoff across partial owner delivery failures.
  const since = state.doneSince ?? (Number.isFinite(Date.parse(state.lastSuccessAt)) ? Date.parse(state.lastSuccessAt) : now - WINDOW_MS);
  const all = selectRows((io.readLedger ?? readLedger)(ledgerFile(home)), now, since);
  const lastVerdicts = { ...(state.lastVerdicts || {}) }, lastKim = { ...(state.lastKim || {}) };
  const lastNeedsDm = { ...(state.lastNeedsDm || {}) };
  // owner 未記録の旧行は自PCの持ち主へ。空のまま notifyOwner に渡すと本文に「宛先: 不明（DM 未解決）」が付く（2026-10-20 実測）。
  const localOwner = io.localOwner ?? (() => { try { return resolveOwner({ home }); } catch { return ''; } })();
  const ownerOf = row => row.owner || localOwner || '';
  const changed = [];
  let observed = false;
  for (const row of all) {
    if (isUnattendedRow(row, home)) continue;
    const key = rowKey(row), eligible = !row.check; // check の結果通知は watch が担当する
    if (!eligible) {
      observed ||= lastVerdicts[key] !== verdictOf(row, now) || lastKim[key] !== kimAction(row) || lastNeedsDm[key] !== false;
      lastVerdicts[key] = verdictOf(row, now); lastKim[key] = kimAction(row); lastNeedsDm[key] = false;
    } else if (lastVerdicts[key] !== verdictOf(row, now) || lastKim[key] !== kimAction(row) || lastNeedsDm[key] === false) changed.push(row);
  }
  if (!changed.length) {
    if (observed && !dryRun) (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm });
    return { sent: false, count: 0 };
  }
  const groups = new Map();
  for (const row of changed) {
    const owner = ownerOf(row);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(row);
  }
  const deliveries = [...groups].map(([owner, candidates]) => {
    const owned = all.filter(row => ownerOf(row) === owner);
    const options = { allRows: owned.filter(row => !isUnattendedRow(row, home)), unattended: owned.filter(row => isUnattendedRow(row, home)).length };
    return { owner, rows: candidates, message: formatDigest(candidates, now, label, options) };
  });
  const messages = deliveries.map(({ message }) => message), text = messages.join('\n');
  const count = deliveries.reduce((n, delivery) => n + delivery.rows.length, 0);
  const digest = createHash('sha256').update(JSON.stringify(deliveries.map(({ owner, message }) => [owner, message]))).digest('hex').slice(0, 16);
  const slotKey = `${new Date(now).toLocaleDateString('sv-SE')}|${slot || defaultSlot(now)}|${digest}`;
  if ((state.sentKeys || []).includes(slotKey)) {
    for (const row of changed) { lastVerdicts[rowKey(row)] = verdictOf(row, now); lastKim[rowKey(row)] = kimAction(row); lastNeedsDm[rowKey(row)] = true; }
    if (!dryRun) (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm });
    return { skipped: 'already-sent', sent: false, count };
  }
  if (dryRun) return { sent: false, count, text, messages };
  let error = '';
  for (const { owner, rows, message } of deliveries) {
    let result;
    try {
      result = io.notify ? await io.notify(message, { home, webhookFallback: false, owner }) : await (io.notifyOwner ?? notifyOwner)(owner, message, { home });
    } catch (cause) { result = { reason: cause?.message || String(cause) }; }
    if (result?.delivered !== 'dm') { error = result?.reason || 'DM not delivered'; break; }
    for (const row of rows) { lastVerdicts[rowKey(row)] = verdictOf(row, now); lastKim[rowKey(row)] = kimAction(row); lastNeedsDm[rowKey(row)] = true; }
    // Persist each successful owner delivery so another owner's failure cannot duplicate it.
    (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm });
  }
  if (error) {
    (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm, lastFailure: { at: new Date(now).toISOString(), slot: slotKey, error } });
    appendLog(home, { at: now, label, slot: slotKey, sent: false, count, error }, io);
    return { sent: false, count, error };
  }
  const next = { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm, lastSuccessAt: new Date(now).toISOString(), sentKeys: [...(state.sentKeys || []), slotKey].slice(-60) };
  (io.writeState ?? writeState)(home, next);
  appendLog(home, { at: now, label, slot: slotKey, sent: true, count, parts: messages.length }, io);
  return { sent: true, count, parts: messages.length };
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await run({ dryRun: process.argv.includes('--dry-run') }))); }
  catch (error) { console.error(String(error?.message ?? error)); }
  process.exitCode = 0;
}
