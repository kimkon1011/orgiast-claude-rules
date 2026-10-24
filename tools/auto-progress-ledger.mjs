#!/usr/bin/env node
// Stop hook: 「この後の自動進行: <text>」の宣言を台帳(~/.claude/auto-progress-ledger.jsonl)へ記録する。
// fail-open: どんな失敗でも exit 0・標準出力なし。Claude の応答を止めない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { resolveOwner } from './notify-owner.mjs';

const NONE = /^(?:なし|無し|ナシ|ありません|—|–|-|－|ー|―|n\/a|none)$/i;
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

// 完了宣言に続く説明を、新しい自動進行の約束として扱わない。
export function isNoopPromise(text) {
  const value = cleanValue(text);
  const first = value.split('。', 1)[0].replace(/[.．\s]+$/g, '').replace(/\s*[（(].*[）)]$/, '').trim();
  return NONE.test(first) || first === '特にありません' ||
    /^完了済み。\s*追加の自動進行なし(?:[。\s]|$)/.test(value) ||
    /(?:作業|自動進行|自動処理|進行|対応)(?:は|が)?(?:ありません|無い|ない|なし)$/.test(first);
}

// 「なし」系（空・None 相当）は null。それ以外は宣言本文を返す。
export function extractPromise(text) {
  const value = lastMatch(PROMISE_RE, text);
  if (!value) return null;
  return isNoopPromise(value) ? null : value;
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

export const MAX_RESUMES = 8; // 1件あたりの自動再開の累計上限（watch/digest 共用。循環 import 回避のためここに置く）

export const OPEN_STATUSES = new Set(['open', 'stalled', 'resumed', 'waiting_user']);

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

export function buildRecord(input, text, { now = Date.now(), hostname = os.hostname(), user = safeUser(), owner = resolveOwner() } = {}) {
  const promise = extractPromise(text);
  if (!promise) return null;
  const transcriptPath = input?.transcript_path || input?.transcriptPath || '';
  const sessionId = input?.session_id || input?.sessionId || path.basename(transcriptPath, '.jsonl');
  if (!sessionId) return null;
  return {
    ts: new Date(now).toISOString(), pc: hostname, user, owner, sessionId, cwd: input?.cwd || process.cwd(), transcriptPath,
    promise, nextKim: extractNextKim(text), status: 'open',
  };
}

function safeUser() { try { return os.userInfo().username; } catch { return ''; } }

// 通知の出どころ1行。DM 本文だけで「どの PC・アカウント・プロジェクトの Claude Code か」を判別できるようにする（2026-10-23 kim 指示）。
export function originLine(row, { label = '', localOwner = '', home = '' } = {}) {
  const pc = label && row.pc && label !== row.pc ? `${label}（${row.pc}）` : (label || row.pc || '不明なPC');
  const account = row.owner || localOwner || row.user || '不明';
  const project = String(row.cwd || '').split(/[\\/]+/).filter(Boolean).pop() || '不明';
  let purpose = row.purpose || row.sessionPurpose || row.objective || '';
  if (!purpose && home && row.sessionId) {
    try { purpose = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'session-purpose', `${row.sessionId}.json`), 'utf8')).purpose || ''; } catch {}
  }
  purpose = String(purpose).replace(/\s+/g, ' ').trim();
  const parts = [`プロジェクト: ${project}`];
  if (purpose) parts.push(`セッションの目的: ${purpose.length > 50 ? `${purpose.slice(0, 50)}…` : purpose}`);
  if (row.sessionId) parts.push(`作業ID: ${String(row.sessionId).slice(0, 8)}`);
  return `【${pc}・${account} の Claude Code】${parts.join(' ／ ')}`;
}

export function record(input, { home, now, hostname, user, owner, readText = (p) => readAssistantText(p).text } = {}) {
  const text = typeof input?.last_assistant_message === 'string' && input.last_assistant_message.trim()
    ? input.last_assistant_message
    : readText(input?.transcript_path || input?.transcriptPath);
  const row = buildRecord(input, text, { now, hostname, user, owner: owner ?? resolveOwner({ home }) });
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

export const rowKey = (row) => `${row.pc}|${row.user}|${row.sessionId}|${row.ts}`;

export function isUnattendedRow(row, home) {
  const normalize = value => String(value || '').replace(/\\/g, '/').replace(/^\/mnt\/([a-z])\//i, '$1:/').replace(/\/+$/, '').toLowerCase();
  const cwd = normalize(row.cwd), root = normalize(home);
  const request = cleanValue(row.requestText || String(row.promise || '').replace(/^API エラー（.*?）で返答できなかった依頼:\s*/, ''));
  const probe = /^(?:[「『"']?)(?:OK|了解)(?:[」』"']?)\s*とだけ\s*(?:返して(?:ください)?|返信して(?:ください)?|答えて(?:ください)?)[。.!！\s]*$/i.test(request);
  return probe || /^c:\/windows\/system32(?:\/|$)/.test(cwd) || /(?:^|\/)\.stall-sweeper(?:\/|$)/.test(cwd) || ['nightly-repo', 'auto-session', 'scratch'].some(name => {
    const base = `${root}/.claude/${name}`;
    return cwd === base || cwd.startsWith(`${base}/`);
  });
}
