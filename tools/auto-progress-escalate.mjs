#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ledgerFile, readLedger, OPEN_STATUSES } from './auto-progress-ledger.mjs';
import { decisionOwnerOf } from './auto-progress-decision-owner.mjs';
import { notifyKim } from './notify-kim.mjs';
import { acquireLock } from './lib/progress-file-lock.mjs';
import { isEntry } from './is-entry.mjs';
import { dropItem, inboxDedupeKey, listInboxMatches } from './kim-inbox.mjs';
import { priorEscalations, syncEscalationAnswer, escalationDedupeKey, parseEscalation } from './lib/escalation-answer-sync.mjs';

const DAY_MS = 86400000;
export const escalationRowKey = row => `${row.sessionId || ''}${row.ts || ''}`;
export function decisionAge(row, now) {
  const times = [row.ts, row.lastCheckedAt].map(Date.parse).filter(Number.isFinite);
  return times.length ? now - Math.min(...times) : NaN;
}
export function escalationText(row, now) {
  const ask = row.ask ? `\n（ask: ${String(row.ask).slice(0, 200)}）` : '';
  const next = row.nextClaude ? `\n（次の手: ${String(row.nextClaude).slice(0, 150)}）` : '';
  return `【要対応・kim の判断待ち ${Math.floor(decisionAge(row, now) / DAY_MS)}日】${String(row.nextKim || '').slice(0, 2000)}\n（元の約束: ${String(row.promise || '').slice(0, 200)} / PC ${row.pc || ''} / セッション ${String(row.sessionId || '').slice(0, 8)} / 台帳 ts ${row.ts || ''}）${ask}${next}`;
}

const escalationStateFile = home => path.join(home, '.claude', 'auto-progress-escalated.json');
function readEscalationState(file) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid escalation state');
  return state;
}
function writeEscalationState(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`);
  fs.renameSync(temp, file);
}

const terminalStatuses = new Set(['done', 'expired', 'superseded', 'skipped']);

/** 終了・削除された台帳行の、作成から5日以上経った open ask を取り下げる。 */
export function sweepStaleEscalations({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, io = {} } = {}) {
  const dropped = [];
  const file = escalationStateFile(home);
  const oldOpenAsk = item => item.kind === 'ask' && item.source === 'auto-progress-escalate'
    && item.status === 'open' && now - Date.parse(item.createdAt) >= 5 * DAY_MS;
  const items = (io.listInboxMatches ?? listInboxMatches)(home, oldOpenAsk);
  if (!items.length) return { dropped };
  const release = dryRun ? () => {} : acquireLock(`${file}.lock`);
  if (!release) return { dropped };
  try {
    const rows = (io.readLedger ?? readLedger)(ledgerFile(home));
    const state = dryRun ? {} : readEscalationState(file);
    for (const item of items) {
      const parsed = parseEscalation(item);
      if (!parsed) continue;
      const sameRow = row => row.ts === parsed.ts && String(row.sessionId || '').slice(0, 8) === parsed.session;
      const matches = rows.filter(sameRow);
      const exact = matches.find(row => inboxDedupeKey(escalationDedupeKey(escalationRowKey(row))) === item.dedupeKey
        || (item.sessionId && row.sessionId === item.sessionId));
      const candidates = exact ? [exact] : matches;
      if (candidates.some(row => !terminalStatuses.has(row.status))) continue;
      const rowStatus = candidates[0]?.status ?? 'missing';
      const reason = `元の台帳行が ${rowStatus} のため自動取り下げ（ask 作成から5日以上）`;
      if (!dryRun) {
        // 先に送信履歴を保存する。取り下げに失敗しても open ask が再送を防ぎ、次回巡回で再試行できる。
        const keys = Object.keys(state).filter(key => item.dedupeKey
          ? inboxDedupeKey(escalationDedupeKey(key)) === item.dedupeKey
          : key.endsWith(parsed.ts) && sameRow({ ts: parsed.ts, sessionId: key.slice(0, -parsed.ts.length) })
            && (!item.sessionId || key === `${item.sessionId}${parsed.ts}`));
        if (keys.length === 1) {
          delete state[keys[0]];
          writeEscalationState(file, state);
        }
        if (!(io.dropItem ?? dropItem)(home, item.id, reason, { autoExpired: true, now })) continue;
      }
      dropped.push({ id: item.id, rowStatus, reason });
    }
    return { dropped };
  } finally { release(); }
}
/** nextKim が kim の操作不要を表すか判定する */
export function isNoKimAction(text) {
  const trimmed = (text ?? '').replace(/^[\s　]+|[\s　]+$/g, '');
  if (!trimmed) return true;
  const keywords = ['なし', '無し', '特になし', '不要', '対応不要'];
  for (const kw of keywords) {
    if (trimmed === kw) return true;
    if (trimmed.startsWith(kw)) {
      const next = trimmed[kw.length];
      if (/^[（(【［〔｛「『）)】］〕｝」』、。，,：:—\-ー\s　\[]/.test(next)) return true;
    }
  }
  return false;
}

export async function escalateKimDecisions({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), dryRun = false, io = {} } = {}) {
  const file = escalationStateFile(home);
  // 読み取り専用の dry-run ではロックも状態ファイルも作らない。
  const release = dryRun ? () => {} : acquireLock(`${file}.lock`);
  if (!release) return { targets: [], sent: 0, skipped: 'locked' };
  try {
    const state = readEscalationState(file);
    const rows = (io.readLedger ?? readLedger)(ledgerFile(home));
    const inbox = io.listInbox ? io.listInbox(home) : listInboxMatches(home, item => item.kind === 'ask');
    const targets = [];
    const suppressed = [];
    let sent = 0;
    const seen = new Set();
    for (const row of rows) {
      if (!OPEN_STATUSES.has(row.status) || decisionOwnerOf(row) !== 'kim' || !(decisionAge(row, now) >= 2 * DAY_MS)) continue;
      const escalatedNextKim = String(row.nextKim ?? '').replace(/^[\s　]+|[\s　]+$/g, '');
      if (isNoKimAction(escalatedNextKim)) continue;
      const key = escalationRowKey(row);
      const lastSent = Date.parse(state[key]);
      if (seen.has(key) || (Number.isFinite(lastSent) && now - lastSent < DAY_MS)) continue;
      seen.add(key);
      // 同じ行の ask が受信箱にあれば新しく積まない。回答済みなら台帳へ書き戻して二度と聞かない（2026-11-19）。
      const prior = priorEscalations(inbox, row);
      if (prior.closed.length || prior.open.length) {
        const reason = prior.closed.length ? 'answered' : 'already-open';
        suppressed.push({ rowKey: key, reason, items: prior.matched.map(item => item.id) });
        if (!dryRun && prior.closed.length) {
          const closedItem = prior.answered || prior.closed[0];
          try { (io.syncAnswer ?? syncEscalationAnswer)(home, closedItem, { now }); }
          catch (error) { (io.stderr ?? console.error)(`auto-progress-escalate: ${key}: 回答の書き戻しに失敗: ${error?.message || error}`); }
        }
        continue;
      }
      const text = escalationText(row, now);
      targets.push({ rowKey: key, text });
      if (dryRun) continue;
      try {
        const result = await (io.notifyKim ?? notifyKim)(text, { kind: 'ask', kimActionRequired: true, sessionId: row.sessionId || '', home, now, source: 'auto-progress-escalate', dedupeKey: escalationDedupeKey(key) });
        if (!['dm', 'webhook', 'session-inbox'].includes(result?.delivered)) {
          (io.stderr ?? console.error)(`auto-progress-escalate: ${key}: ${result?.delivered || 'none'}: ${result?.reason || 'not delivered'}`);
          continue;
        }
        state[key] = new Date(now).toISOString();
        writeEscalationState(file, state);
        sent++;
      } catch (error) {
        (io.stderr ?? console.error)(`auto-progress-escalate: ${key}: ${error?.message || error}`);
      }
    }
    return { targets, sent, suppressed };
  } finally { release(); }
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await escalateKimDecisions({ dryRun: process.argv.includes('--dry-run') }), null, 2)); }
  catch (error) { console.error(error?.message || error); process.exitCode = 1; }
}
