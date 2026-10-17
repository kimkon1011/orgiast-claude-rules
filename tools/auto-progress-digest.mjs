#!/usr/bin/env node
// 各PCのローカル台帳から、完了・進行中・停滞/再開・期限超過を kim の DM へ定期報告する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { notifyKim } from './notify-kim.mjs';
import { ledgerFile, readLedger } from './auto-progress-ledger.mjs';
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
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (row.status === 'done') return Number.isFinite(Date.parse(row.doneAt)) && Date.parse(row.doneAt) > since;
    if (row.status === 'open' && deadlinePassed(row, now)) return true;
    return row.status === 'resumed' || row.verdict === 'in_progress' || (row.status === 'open' && Number.isFinite(Date.parse(row.lastCheckedAt)));
  }).sort((a, b) => rowTime(a) - rowTime(b));
}

const verdictOf = (row) => row.status === 'done' ? 'done' : row.status === 'resumed' ? `resumed${row.resumeOutcome ? ` (${row.resumeOutcome})` : ''}` : row.verdict || (row.lastCheckedAt ? 'in_progress' : 'open/期限超過');
export function formatDigest(rows, now = Date.now(), label = '') {
  if (!rows.length) return '';
  const lines = rows.map((row) => {
    const purpose = row.purpose || row.sessionPurpose || row.objective;
    const judgedAt = row.doneAt || row.lastCheckedAt || row.resumedAt || row.ts;
    return `・${row.pc || label}／${purpose ? `目的: ${String(purpose).slice(0, 80)}／` : ''}約束: ${String(row.promise || '').slice(0, 120)}／判定: ${verdictOf(row)}／${judgedAt || new Date(now).toISOString()}`;
  });
  return `${label} 自動進行の定期進捗 ${rows.length}件\n${lines.join('\n')}`;
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
  const since = Number.isFinite(Date.parse(state.lastSuccessAt)) ? Date.parse(state.lastSuccessAt) : now - WINDOW_MS;
  const rows = selectRows((io.readLedger ?? readLedger)(ledgerFile(home)), now, since);
  if (!rows.length) return { sent: false, count: 0 };
  const text = formatDigest(rows, now, label);
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const slotKey = `${new Date(now).toLocaleDateString('sv-SE')}|${slot || defaultSlot(now)}|${digest}`;
  if ((state.sentKeys || []).includes(slotKey)) return { skipped: 'already-sent', sent: false, count: rows.length };
  const messages = splitMessages(text);
  if (dryRun) return { sent: false, count: rows.length, text, messages };
  let error = '';
  for (const message of messages) {
    const result = await (io.notify ?? notifyKim)(message, { home, webhookFallback: false });
    if (result?.delivered !== 'dm') { error = result?.reason || 'DM not delivered'; break; }
  }
  if (error) {
    (io.writeState ?? writeState)(home, { ...state, lastFailure: { at: new Date(now).toISOString(), slot: slotKey, error } });
    appendLog(home, { at: now, label, slot: slotKey, sent: false, count: rows.length, error }, io);
    return { sent: false, count: rows.length, error };
  }
  const next = { lastSuccessAt: new Date(now).toISOString(), sentKeys: [...(state.sentKeys || []), slotKey].slice(-60) };
  (io.writeState ?? writeState)(home, next);
  appendLog(home, { at: now, label, slot: slotKey, sent: true, count: rows.length, parts: messages.length }, io);
  return { sent: true, count: rows.length, parts: messages.length };
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await run({ dryRun: process.argv.includes('--dry-run') }))); }
  catch (error) { console.error(String(error?.message ?? error)); }
  process.exitCode = 0;
}
