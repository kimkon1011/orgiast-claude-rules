#!/usr/bin/env node
// Stop hook: 「この後の自動進行: <text>」の宣言を台帳(~/.claude/auto-progress-ledger.jsonl)へ記録する。
// fail-open: どんな失敗でも exit 0・標準出力なし。Claude の応答を止めない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { resolveOwner } from './lib/owner-identity.mjs';
import { externalSpec, recentSessionSends, monitorCommand, MONITOR_DAYS } from './lib/external-monitor-state.mjs';

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
  const first = value.replace(/\s*[（(].*[）)]$/, '').split('。', 1)[0].replace(/[.．\s]+$/g, '').trim();
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

export const LEDGER_RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const LEDGER_RENAME_ATTEMPTS = 10;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

export function writeLedger(file, rows, io = {}) {
  const mkdirSync = io.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const rmSync = io.rmSync ?? fs.rmSync;
  const wait = io.sleepSync ?? sleepSync;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  try {
    for (let attempt = 0; attempt < LEDGER_RENAME_ATTEMPTS; attempt += 1) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        if (!LEDGER_RENAME_RETRY_CODES.has(error?.code) || attempt === LEDGER_RENAME_ATTEMPTS - 1) throw error;
        wait(Math.min(50 * (2 ** attempt), 2000));
      }
    }
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* 元の rename エラーを優先する */ }
    throw error;
  }
}

export function cleanupOldLedgerTemps(file, { now = Date.now(), maxAgeMs = 3600000, io = {} } = {}) {
  const readdirSync = io.readdirSync ?? fs.readdirSync;
  const statSync = io.statSync ?? fs.statSync;
  const rmSync = io.rmSync ?? fs.rmSync;
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = path.join(dir, name);
    try {
      if (now - statSync(candidate).mtimeMs <= maxAgeMs) continue;
      rmSync(candidate, { force: true });
      removed += 1;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return removed;
}

export const MAX_RESUMES = 8; // 1件あたりの自動再開の累計上限（watch/digest 共用。循環 import 回避のためここに置く）

export const OPEN_STATUSES = new Set(['open', 'stalled', 'resumed', 'waiting_user', 'scheduled', 'starting', 'start_overdue']);

// Timestamp order is authoritative; equal timestamps prefer the later ledger line.
export function latestOpenPromises(rows) {
  const latest = new Map();
  const active = rows.filter(row => OPEN_STATUSES.has(row.status));
  for (const row of active) {
    if (!row.sessionId) continue;
    const key = row.check ? `${row.sessionId}\0${row.label ?? ''}` : row.sessionId;
    const previous = latest.get(key);
    if (!previous || (Date.parse(row.ts) || 0) >= (Date.parse(previous.ts) || 0)) latest.set(key, row);
  }
  return active.filter(row => {
    if (!row.sessionId) return true;
    const key = row.check ? `${row.sessionId}\0${row.label ?? ''}` : row.sessionId;
    return latest.get(key) === row;
  });
}

// 同一 sessionId の通常行、または同一 sessionId + label の check 行は最新で置換する。
// 同じ session に open の自動確認行があるときは、新しい約束行に予約・check 情報を引き継ぐ。
export function applyPromise(rows, record) {
  let toAdd = record;
  if (!toAdd.check && !toAdd.startWhen && !toAdd.autoRegisteredCheck) {
    const existing = rows
      .filter((row) => row.sessionId === record.sessionId && OPEN_STATUSES.has(row.status) && !externalSpec(row) && (row.check || row.startWhen || row.autoRegisteredCheck === true))
      .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))[0];
    if (existing) {
      toAdd = {
        ...toAdd,
        ...(existing.startWhen ? { startWhen: existing.startWhen, startedAt: existing.startedAt,
          ...(['scheduled', 'starting', 'start_overdue'].includes(existing.status) ? { status: existing.status } : {}) } : {}),
        ...(existing.autoRegisteredCheck ? { autoRegisteredCheck: true } : {}),
        check: existing.check,
        checkRegisteredAt: existing.checkRegisteredAt,
        checkCwd: existing.checkCwd ?? toAdd.cwd,
        deadlineAt: existing.deadlineAt,
        label: existing.label,
        nextClaude: existing.nextClaude,
        ...Object.fromEntries(['lastCheckOutput', 'progressFingerprint', 'progressOutput', 'progressDay',
          'progressInboxId', 'progressPending'].filter(key => existing[key] !== undefined).map(key => [key, existing[key]])),
        ...(existing.checkTimeoutMs ? { checkTimeoutMs: existing.checkTimeoutMs } : {}),
        ...(existing.lastUnmetNotifiedAt ? { lastUnmetNotifiedAt: existing.lastUnmetNotifiedAt } : {}),
      };
    }
  }
  const replaces = (row) => {
    if (row.sessionId !== toAdd.sessionId || !OPEN_STATUSES.has(row.status)) return false;
    if (row.check) return Boolean(toAdd.check) && row.label === toAdd.label;
    return true;
  };
  const next = rows.map((row) => (replaces(row) ? { ...row, supersededFromStatus: row.status, status: 'superseded' } : row));
  next.push(toAdd);
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
  const synthetic = value => /^\s*<(?:task-notification\b|system-reminder\b|command-)/.test(String(value));
  if ((!purpose || synthetic(purpose)) && row.transcriptPath) {
    purpose = '';
    try {
      for (const line of fs.readFileSync(row.transcriptPath, 'utf8').split(/\r?\n/)) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.isSidechain || (entry.message?.role || entry.type) !== 'user') continue;
        const content = entry.message?.content;
        const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '');
        if (text.trim() && !synthetic(text)) { purpose = text; break; }
      }
    } catch { /* ログが無い場合は台帳の label を使う。 */ }
  }
  if (!purpose || synthetic(purpose)) purpose = row.label || '';
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
  const waiting = /(?:返信|返事|回答)待ち/.test(row.promise);
  const sends = waiting ? recentSessionSends(row.transcriptPath, home, now ?? Date.now()) : [];
  let rows = readLedger(file);
  const ownsWait = waiting && (sends.length || rows.some(r => r.sessionId === row.sessionId && OPEN_STATUSES.has(r.status) && externalSpec(r)));
  // Do not supersede unrelated checks or copy a monitor's cursor into a new declaration.
  if (ownsWait) rows.push({ ...row, status: 'superseded' });
  else rows = applyPromise(rows, row);
  const recorded = rows.at(-1);
  if (waiting) {
    for (const spec of sends) {
      const existing = rows.find(r => r.sessionId === row.sessionId && OPEN_STATUSES.has(r.status) &&
        externalSpec(r)?.channel === spec.channel && externalSpec(r)?.threadId === spec.threadId && externalSpec(r)?.mailbox === spec.mailbox);
      if (existing) continue; // Preserve cursor and original expiry across repeated Stop hooks.
      rows.push({ ...row, status: 'open', promise: '外部チャネルの返信待ちを継続監視', label: `外部返信待ち:${spec.channel}:${spec.threadId}`, check: monitorCommand(spec),
        checkCwd: row.cwd, checkRegisteredAt: row.ts, externalMonitor: true, nextKim: 'なし', nextClaude: '',
        deadlineAt: new Date((now ?? Date.now()) + MONITOR_DAYS).toISOString() });
    }
  }
  writeLedger(file, rows);
  return recorded;
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    record(JSON.parse(raw));
  } catch { /* fail-open */ }
}

if (isEntry(import.meta.url)) { await main(); process.exitCode = 0; }

export const rowKey = (row) => {
  const spec = externalSpec(row);
  return `${row.pc}|${row.user}|${row.sessionId}|${row.ts}${spec ? `|external:${spec.channel}:${spec.mailbox || ''}:${spec.threadId}` : ''}`;
};

export { isUnattendedRow } from './lib/unattended-session.mjs';

export const kimAction = row => {
  const value = String(row.nextKim || '').trim();
  const action = /^(?:(?:特に)?なし|無し|ナシ|(?:対応(?:は)?)?不要(?:です)?|(?:特に)?ありません|none|n\/a|[-—–－ー―])(?:[（(].*[）)])?[。．]?$/i.test(value) || !value ? 'なし' : value;
  return action === 'なし' && row.status === 'waiting_user'
    ? String(row.reason || row.resumeOutcome || '判断内容を確認してください').replace(/^needs_user:\s*/, '').slice(0, 80) : action;
};

export function hasClaudeWork(value) {
  const text = cleanValue(value);
  if (!text || isNoopPromise(text)) return false;
  return /マージ|merge|配布|実装|送信|送る|送ります|組み込|反映|修正|更新|登録|記録|確認|調査|作成|通知|進め|対応|監視|deploy|push/i.test(text);
}
