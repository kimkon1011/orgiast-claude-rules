#!/usr/bin/env node
// Stop hook: 「この後の自動進行: <text>」の宣言を台帳(~/.claude/auto-progress-ledger.jsonl)へ記録する。
// fail-open: どんな失敗でも exit 0・標準出力なし。Claude の応答を止めない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const NONE = /^(?:なし|無し|ナシ|—|–|-|－|ー|―|n\/a|none)$/i;
// 「**この後の自動進行**: text」「- この後の自動進行：text」など装飾付きにも一致させる。
const PROMISE_RE = /この後の自動進行[\s*`_)）」』]*[:：][ \t]*([^\r\n]*)/g;
const NEXT_KIM_RE = /次に\s*kim\s*がすること[\s*`_)）」』]*[:：][ \t]*([^\r\n]*)/gi;

export function cleanValue(value) {
  return String(value ?? '').replace(/^[\s*`_]+|[\s*`_]+$/g, '').trim();
}

function lastMatch(re, text) {
  let found = null;
  for (const match of String(text ?? '').matchAll(re)) found = match;
  return found ? cleanValue(found[1]) : null;
}

// 「なし」系（空・None 相当）は null。それ以外は宣言本文を返す。
export function extractPromise(text) {
  const value = lastMatch(PROMISE_RE, text);
  if (!value) return null;
  const bare = value.replace(/[。.．\s]+$/g, '').replace(/\s*[（(].*[）)]$/, '').trim();
  return !bare || NONE.test(bare) ? null : value;
}

export function extractNextKim(text) {
  return lastMatch(NEXT_KIM_RE, text) || '';
}

export const ledgerFile = (home = process.env.ORGIAST_HOME || os.homedir()) => path.join(home, '.claude', 'auto-progress-ledger.jsonl');

export function readLedger(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row); } catch { /* 壊れた行は捨てる */ }
  }
  return rows;
}

export function writeLedger(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(temp, file);
}

export const OPEN_STATUSES = new Set(['open', 'stalled', 'resumed']);

// Timestamp order is authoritative; equal timestamps prefer the later ledger line.
export function latestOpenPromises(rows) {
  const latest = new Map();
  const active = rows.filter(row => OPEN_STATUSES.has(row.status));
  for (const row of active) {
    if (!row.sessionId) continue;
    const previous = latest.get(row.sessionId);
    if (!previous || (Date.parse(row.ts) || 0) >= (Date.parse(previous.ts) || 0)) latest.set(row.sessionId, row);
  }
  return active.filter(row => !row.sessionId || latest.get(row.sessionId) === row);
}

// 同一 sessionId の open 行は最新で置換する（旧行は superseded）。resumed も「進行中の宣言」なので置換対象。
export function applyPromise(rows, record) {
  const next = rows.map((row) => (row.sessionId === record.sessionId && OPEN_STATUSES.has(row.status) ? { ...row, status: 'superseded' } : row));
  next.push(record);
  return next;
}

export function buildRecord(input, text, { now = Date.now(), hostname = os.hostname(), user = safeUser() } = {}) {
  const promise = extractPromise(text);
  if (!promise) return null;
  const transcriptPath = input?.transcript_path || input?.transcriptPath || '';
  const sessionId = input?.session_id || input?.sessionId || path.basename(transcriptPath, '.jsonl');
  if (!sessionId) return null;
  return {
    ts: new Date(now).toISOString(), pc: hostname, user, sessionId, cwd: input?.cwd || process.cwd(), transcriptPath,
    promise, nextKim: extractNextKim(text), status: 'open',
  };
}

function safeUser() { try { return os.userInfo().username; } catch { return ''; } }

export function record(input, { home, now, hostname, user, readText = (p) => readAssistantText(p).text } = {}) {
  const text = typeof input?.last_assistant_message === 'string' && input.last_assistant_message.trim()
    ? input.last_assistant_message
    : readText(input?.transcript_path || input?.transcriptPath);
  const row = buildRecord(input, text, { now, hostname, user });
  if (!row) return null;
  const file = ledgerFile(home);
  writeLedger(file, applyPromise(readLedger(file), row));
  return row;
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    record(JSON.parse(raw));
  } catch { /* fail-open */ }
}

if (isEntry(import.meta.url)) { await main(); process.exitCode = 0; }
