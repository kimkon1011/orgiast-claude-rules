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
import { readDeferred, drainDeferred, appendDeferred, formatDeferredSection } from './discord-notify-deferred.mjs';

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
const shortReasons = {
  '証拠なし（約束後の会話・ファイル更新・実行ログが無い）': 'その後の動きがありません',
  '最後の動きから1時間以上経過': 'しばらく動きがありません',
  '最後の動きから24時間以上経過': 'しばらく動きがありません',
  '直近1時間以内に動きあり': '動いています',
};

function itemText(row, now) {
  const verdict = verdictOf(row, now), attempts = Number(row.resumeCount) || 0;
  const states = { done: '終わりました', in_progress: '進んでいます', open: 'まだ始まっていません', stalled: '止まっています', resumed: `自動で再開しました（${attempts} 回目）`, waiting_user: 'kim の判断待ち', 'open/期限超過': '期限を過ぎています' };
  const next = verdict === 'done' ? 'なし（これで終わりです）' : verdict === 'waiting_user' ? 'kim の返事を待っています' : verdict === 'stalled' && attempts >= MAX_RESUMES ? '自動再開を使い切りました。このまま 7 日で閉じます。続けるなら kim が指示してください' : verdict === 'stalled' ? `2 時間後の巡回で自動で再開します（${attempts + 1} 回目）` : '次の巡回で確認します';
  const reason = readable(shortReasons[row.reason] || row.reason || row.resumeOutcome, row, 40);
  return `・${readable(row.purpose || row.sessionPurpose || row.objective || row.promise || '約束した作業', row, 60)}\n  今: ${states[verdict] || states.open}${reason ? `（${reason}）` : ''}\n  次に自動でやること: ${next} ／ kim がすること: ${readable(kimAction(row), row, 80)}`;
}
export function formatDigest(rows, now = Date.now(), label = '', { allRows = rows, unattended = 0, remaining = 0 } = {}) {
  rows = rows.filter(row => !isNoopPromise(row.promise));
  allRows = allRows.filter(row => !isNoopPromise(row.promise));
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
  const entries = dryRun ? readDeferred(home, { now }) : drainDeferred(home, { now }).entries;
  const deferredSection = formatDeferredSection(entries, { now });
  const deferredResult = entries.length ? { deferred: entries.length } : {};
  const lastVerdicts = { ...(state.lastVerdicts || {}) }, lastKim = { ...(state.lastKim || {}) };
  const lastNeedsDm = { ...(state.lastNeedsDm || {}) };
  // owner 未記録の旧行は自PCの持ち主へ。空のまま notifyOwner に渡すと本文に「宛先: 不明（DM 未解決）」が付く（2026-10-20 実測）。
  const localOwner = io.localOwner ?? (() => { try { return resolveOwner({ home }); } catch { return ''; } })();
  const ownerOf = row => row.owner || localOwner || '';
  const changed = [];
  let observed = false;
  for (const row of all) {
    if (isUnattendedRow(row, home)) continue;
    const key = rowKey(row), eligible = needsDm(row, now);
    if (!eligible) {
      observed ||= lastVerdicts[key] !== verdictOf(row, now) || lastKim[key] !== kimAction(row) || lastNeedsDm[key] !== false;
      lastVerdicts[key] = verdictOf(row, now); lastKim[key] = kimAction(row); lastNeedsDm[key] = false;
    } else if (lastVerdicts[key] !== verdictOf(row, now) || lastKim[key] !== kimAction(row) || lastNeedsDm[key] === false) changed.push(row);
  }
  if (!changed.length && !deferredSection) {
    if (observed && !dryRun) (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm });
    return { sent: false, count: 0, ...deferredResult };
  }
  const groups = new Map();
  for (const row of changed.slice(0, MAX_ITEMS)) {
    const owner = ownerOf(row);
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(row);
  }
  let deliveries = [...groups].map(([owner, candidates]) => {
    const owned = all.filter(row => ownerOf(row) === owner);
    const options = { allRows: owned.filter(row => !isUnattendedRow(row, home)), unattended: owned.filter(row => isUnattendedRow(row, home)).length };
    const total = changed.filter(row => ownerOf(row) === owner).length;
    let rows = candidates;
    let message;
    do {
      message = formatDigest(rows, now, label, { ...options, remaining: total - rows.length });
      if (message.length <= MAX_MESSAGE || rows.length === 1) break;
      rows = rows.slice(0, -1);
    } while (rows.length);
    return { owner, rows, message };
  });
  if (deferredSection) {
    if (!deliveries.length) deliveries = [{ owner: localOwner, rows: [], message: deferredSection }];
    else deliveries[0].message = [deferredSection, deliveries[0].message].filter(Boolean).join('\n\n');
  }
  const messages = deliveries.map(({ message }) => message), text = messages.join('\n');
  const count = deliveries.reduce((n, delivery) => n + delivery.rows.length, 0);
  const digest = createHash('sha256').update(JSON.stringify(deliveries.map(({ owner, message }) => [owner, message]))).digest('hex').slice(0, 16);
  const slotKey = `${new Date(now).toLocaleDateString('sv-SE')}|${slot || defaultSlot(now)}|${digest}`;
  if ((state.sentKeys || []).includes(slotKey)) return { skipped: 'already-sent', sent: false, count, ...deferredResult };
  if (dryRun) return { sent: false, count, ...deferredResult, text, messages };
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
    // 送れなかった回の保留通知は戻す（drain したままだと永久に消える）。
    if (entries.length && !dryRun) (io.appendDeferred ?? appendDeferred)(home, entries);
    (io.writeState ?? writeState)(home, { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm, lastFailure: { at: new Date(now).toISOString(), slot: slotKey, error } });
    appendLog(home, { at: now, label, slot: slotKey, sent: false, count, error }, io);
    return { sent: false, count, ...deferredResult, error };
  }
  const next = { ...state, doneSince: since, lastVerdicts, lastKim, lastNeedsDm, lastSuccessAt: new Date(now).toISOString(), sentKeys: [...(state.sentKeys || []), slotKey].slice(-60) };
  (io.writeState ?? writeState)(home, next);
  appendLog(home, { at: now, label, slot: slotKey, sent: true, count, parts: messages.length }, io);
  return { sent: true, count, ...deferredResult, parts: messages.length };
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await run({ dryRun: process.argv.includes('--dry-run') }))); }
  catch (error) { console.error(String(error?.message ?? error)); }
  process.exitCode = 0;
}
