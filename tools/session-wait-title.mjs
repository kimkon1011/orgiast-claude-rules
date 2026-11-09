#!/usr/bin/env node
// Stop hook: 応答末尾の「このセッション: まだ閉じない（…YYYY-MM-DD HH:MM まで待つ）」の期限を、
// セッション一覧のタイトルの頭に【11/02/20:11まで】の形（年なし）で付ける（2026-10-27 nishi 指示・全PC全アカウント）。
// 一覧を見ただけで、どのタブをいつまで開けておくかが分かるようにする。
// 閉じてよい定型文になったら頭の期限を外し、「次に kim がすること」が無い（なし等）か閉じる操作だけなら【閉じて可】を付ける
// （2026-11-02 kim 指示・全PC全アカウント。kim のやることが残るセッションは閉じてよい定型文でも付けない）。
// 最新フッターの待機期限は過去のクローズ台帳より優先する。フッター無しでは台帳・既存の印を保持。fail-open・出力なし。
// 本体はノイズを除外し、手動の命名を最優先、その次に assistant が最初に宣言した目的を使う。
// --prompt-submit: 既存タイトルにPC番号を付けてサーバーへ同期する（transcript は読み取り専用）。
// --all: 既存の全セッション（直近 RECENT_DAYS 日）にも同じ規則を当てる。SessionStart から1時間に1回だけ走る。
import fs from 'node:fs';
import { dropClosed } from './purge-sessions.mjs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { resolvePcNumber } from './lib/pc-number.mjs';
import { footerValues as footerValuesStrict, NO_ACTION_PATTERN, openDeadline, SESSION_PHRASES } from './next-action-gate.mjs';
import { ledgerFile, readLedger, OPEN_STATUSES } from './auto-progress-ledger.mjs';

// Lenient footer parser: normalizes full-width colons (：) to half-width (:) before matching.
// The gate (next-action-gate.mjs) is strict and requires half-width colons, but the hook
// must accept both variants because assistant messages sometimes use full-width colons.
function footerValues(text) {
  const normalized = String(text || '').replace(/：/g, ':');
  return footerValuesStrict(normalized);
}

const MAX_BYTES = 256 * 1024 * 1024;
const RECENT_DAYS = 30;
const SWEEP_COOLDOWN_MS = 60 * 60 * 1000;
const LOG_FILE = path.join(os.homedir(), '.claude', 'logs', 'session-wait-title.log');

function logError(msg, err) {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg} ${err?.stack || err}\n`);
  } catch { /* best-effort */ }
}
export const CLOSABLE_PREFIX = '【閉じて可】';
// 旧形式【26/11/02/20:11まで】（年あり）も外して新形式へ付け替える。期限と【閉じて可】は排他で、どちらも付け替え対象。
const PREFIX = /^(?:(?:【(?:\d{2}\/)?\d{2}\/\d{2}\/\d{2}:\d{2}まで】|【閉じて可】)\s*)+/;

// /session-close records completion independently of the assistant's final footer.
function isRecordedClosed(id) {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'closed-sessions.json'), 'utf8').replace(/^\uFEFF/, '')).ids.includes(id); }
  catch { return false; }
}

// 任意の作業を巻き込まないよう、各片を許可した閉じる操作の全文と照合する。
export function isCloseRitualOnly(nextAction) {
  if (typeof nextAction !== 'string') return false;
  const tab = '(?:(?:タブバーの)?(?:一番右|右端)(?:にある|の))?(?:新しい|この|古い)?タブ';
  const start = new RegExp(`^${tab}で\\s*(?:Enter\\s*を\\s*(?:1回\\s*)?押(?:す|し)|/session-start\\s*を\\s*送(?:る|り))$`);
  const close = /^(?:(?:この)?(?:古い)?タブを\s*(?:✕\s*で\s*)?|(?:この)?セッションを\s*)閉じ(?:る|て|ます)$/;
  return nextAction.split(/[、。→，]/).every(part => {
    const text = part.trim();
    return !text || start.test(text) || close.test(text);
  });
}

// 閉じてよい定型文（closed / delete）で、かつ kim のやることが無いか閉じる操作だけなら true。
export function isClosable(footer) {
  return !!footer && [SESSION_PHRASES.closed, SESSION_PHRASES.delete].includes(footer.session)
    && (NO_ACTION_PATTERN.test(footer.nextAction) || isCloseRitualOnly(footer.nextAction));
}

export function latestWaitDeadline(text) {
  const footer = footerValues(text);
  return footer ? openDeadline(footer.session) : null;
}

function reopenRecordedSession(id) {
  dropClosed(path.join(os.homedir(), '.claude'), new Set([id]));
}

function logReopen(message) {
  const file = path.join(os.homedir(), '.claude', 'logs', 'session-wait-title.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}

export function waitPrefix(date) {
  const p = n => String(n).padStart(2, '0');
  return `【${p(date.getMonth() + 1)}/${p(date.getDate())}/${p(date.getHours())}:${p(date.getMinutes())}まで】`;
}

// この session_id に登録済みの auto-progress チェックのうち、未完了で最も早い deadline を返す。
// ref（最後の assistant 応答時刻）より前の deadline は無視する。
// チェックが無ければ null。
export function earliestAutoProgressDeadline(sessionId, { home = process.env.ORGIAST_HOME || os.homedir(), ledgerRows, ref } = {}) {
  try {
    const rows = ledgerRows ?? readLedger(ledgerFile(home));
    const latestByKey = new Map();
    for (const row of rows) {
      if (!row || !row.sessionId) continue;
      const key = row.check ? `${row.sessionId}\0${row.label ?? ''}` : row.sessionId;
      const existing = latestByKey.get(key);
      const rowTs = Date.parse(row.ts) || 0;
      const existingTs = existing ? (Date.parse(existing.ts) || 0) : -1;
      if (!existing || rowTs >= existingTs) {
        latestByKey.set(key, row);
      }
    }
    const refMs = typeof ref === 'number' ? ref : (ref instanceof Date ? ref.getTime() : (Date.parse(ref) || 0));
    const matching = [];
    for (const row of latestByKey.values()) {
      if (row.sessionId !== sessionId) continue;
      if (!OPEN_STATUSES.has(row.status)) continue;
      if (!row.deadlineAt) continue;
      const d = new Date(row.deadlineAt);
      if (Number.isFinite(d.getTime())) {
        if (!refMs || d.getTime() >= refMs) {
          matching.push(d);
        }
      }
    }
    if (!matching.length) return null;
    return matching.reduce((a, b) => a.getTime() < b.getTime() ? a : b);
  } catch { return null; }
}

// フッターの autopilot 本文から日時を抽出する。
// 対応書式: M/D H:MM, M/D HH:MM, YYYY-MM-DD HH:MM, M月D日 H時
// 時刻なしの M/D だけならその日の 23:59。年はセッション最終応答時点から見て未来になる年。
// 複数あれば最も遅い日時を返す。1つも無ければ null。
export function extractDeadlineFromAutopilot(text, { ref, now } = {}) {
  if (!text) return null;
  const refValue = ref ?? now ?? Date.now();
  const refMs = typeof refValue === 'number' ? refValue : (refValue instanceof Date ? refValue.getTime() : Date.parse(refValue) || Date.now());
  const refDate = new Date(refMs);
  const baseYear = refDate.getFullYear();
  const DAY_180_MS = 180 * 24 * 60 * 60 * 1000;
  const candidates = [];

  const adjustYear = (d) => {
    if (refMs - d.getTime() >= DAY_180_MS) {
      d.setFullYear(baseYear + 1);
    }
    return d;
  };

  // YYYY-MM-DD HH:MM
  for (const m of text.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})/g)) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    if (Number.isFinite(d.getTime())) candidates.push(d);
  }
  // M/D H:MM or M/D HH:MM
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?!\d)/g)) {
    const mo = Number(m[1]), day = Number(m[2]), h = Number(m[3]), mi = Number(m[4]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59) continue;
    const d = adjustYear(new Date(baseYear, mo - 1, day, h, mi));
    if (Number.isFinite(d.getTime())) candidates.push(d);
  }
  // M月D日 H時 (e.g. "11月17日 9時")
  for (const m of text.matchAll(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2})時/g)) {
    const mo = Number(m[1]), day = Number(m[2]), h = Number(m[3]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23) continue;
    const d = adjustYear(new Date(baseYear, mo - 1, day, h, 0));
    if (Number.isFinite(d.getTime())) candidates.push(d);
  }
  // M/D のみ（時刻なし）→ その日の 23:59
  for (const m of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/:])(?!\s*\d{1,2}:\d)/g)) {
    const mo = Number(m[1]), day = Number(m[2]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
    const d = adjustYear(new Date(baseYear, mo - 1, day, 23, 59));
    if (Number.isFinite(d.getTime())) candidates.push(d);
  }
  if (!candidates.length) return null;
  // 最も遅い日時（＝待ち終わり）を返す
  return candidates.reduce((a, b) => a.getTime() > b.getTime() ? a : b);
}

// 「まだ閉じない」系のセッション行で openDeadline が null のとき、期限を推定する。
// 1. autopilot 本文からの日付抽出
// 2. 1 が無い時だけ、auto-progress 台帳の open check の deadline。ただし ref より前の deadline は無視し、残りのうち最も早いもの。
// 3. どちらも無ければ null（呼び出し側で既存 prefix 保持）。
export function estimateWaitDeadline(sessionId, footer, { ref = Date.now(), home = process.env.ORGIAST_HOME || os.homedir(), ledgerRows } = {}) {
  // 1. autopilot 本文から日付抽出（最優先）
  if (footer?.autopilot) {
    const extracted = extractDeadlineFromAutopilot(footer.autopilot, { ref });
    if (extracted) return extracted;
  }
  // 2. auto-progress チェックの deadline（ref 以降のもの）
  const apDeadline = earliestAutoProgressDeadline(sessionId, { home, ledgerRows, ref });
  if (apDeadline) return apDeadline;

  return null;
}

function isNoiseText(text) {
  return /^(?:<|Base directory for this skill:|Stop hook feedback:|\[SYSTEM NOTIFICATION|Caveat:)/.test(text.trim());
}

// transcript から現在のタイトルと、最初の依頼・宣言目的を拾う。
export function currentTitles(raw) {
  let custom = '', ai = '', firstPrompt = '', autoAi = '', customSource = '', declaredPurpose = '';
  for (const line of String(raw || '').split('\n')) {
    if (line.includes('"custom-title"')) { try { const e = JSON.parse(line); if (e.type === 'custom-title' && typeof e.customTitle === 'string') { custom = e.customTitle; customSource = e.source || ''; autoAi = ''; } } catch {} }
    else if (line.includes('"ai-title"')) { try { const e = JSON.parse(line); if (e.type === 'ai-title' && typeof e.aiTitle === 'string') { ai = e.aiTitle; if (customSource === 'orgiast-auto') autoAi = ai; } } catch {} }
    else if (!firstPrompt && line.includes('"type":"user"')) {
      try {
        const c = JSON.parse(line).message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find(b => b?.type === 'text')?.text : '';
        if (text && !isNoiseText(text)) firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 40);
      } catch {}
    }
    else if (!declaredPurpose && line.includes('"assistant"')) {
      try {
        const e = JSON.parse(line);
        if (e.type !== 'assistant') continue;
        const c = e.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
        const purpose = text.match(/(?:\*\*)?\[本セッションの目的\](?:\*\*)?[ \t]*([^\r\n]+)/)?.[1];
        if (purpose) declaredPurpose = purpose.replace(/\s+/g, ' ').trim().slice(0, 40);
      } catch {}
    }
  }
  return { custom, ai, firstPrompt, autoAi, customSource, declaredPurpose };
}

export function lastAssistantText(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    try {
      const c = JSON.parse(lines[i]).message?.content;
      const text = Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
      if (text.trim()) return text;
    } catch {}
  }
  return '';
}

export function lastAssistantTimestamp(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e.type !== 'assistant') continue;
      const ts = e.timestamp || e.ts || e.message?.timestamp;
      if (ts) {
        const d = new Date(ts);
        if (Number.isFinite(d.getTime())) return d.getTime();
      }
    } catch {}
  }
  return null;
}

const withoutPc = title => title.replace(/^\d{3}｜/, '');
function titleBody(title) {
  const body = withoutPc(title.trim()).replace(PREFIX, '').trim();
  return isNoiseText(body) ? '' : body;
}

// hook の仮名は source なしで記録されても人の /rename として扱わない。
function isPlaceholder(title) {
  return titleBody(title) === '待機中';
}

// 書くべき custom-title を返す。変更不要なら null。
export function desiredTitle(text, raw, pc = '', closed = false, sessionId = '', options = {}) {
  const footer = footerValues(text);
  if (!footer && !pc && !closed) return null;
  const { custom, ai, firstPrompt, autoAi, customSource, declaredPurpose } = currentTitles(raw);
  const existingPrefix = withoutPc(custom).match(PREFIX)?.[0] || '';
  const customBody = isPlaceholder(custom) ? '' : titleBody(custom);
  const base = (customSource !== 'orgiast-auto' ? customBody : '')
    || declaredPurpose || titleBody(autoAi) || customBody || titleBody(ai) || firstPrompt || 'セッション';
  const deadline = footer ? openDeadline(footer.session) : null;
  let prefix;
  if (deadline) {
    prefix = waitPrefix(deadline);
  } else if (closed || isClosable(footer)) {
    prefix = CLOSABLE_PREFIX;
  } else if (footer && !deadline && (footer.session.startsWith('まだ閉じない（作業中') || footer.session.startsWith('/session-close をして（まだ閉じない'))) {
    // 期限なしの「まだ閉じない」→ auto-progress チェック or フッター本文から推定
    const ref = options.ref ?? lastAssistantTimestamp(raw) ?? options.now ?? Date.now();
    const estimated = estimateWaitDeadline(sessionId, footer, { ref, home: options.home, ledgerRows: options.ledgerRows });
    prefix = estimated ? waitPrefix(estimated) : existingPrefix;
  } else if (!footer) {
    prefix = existingPrefix;
  } else {
    prefix = '';
  }
  // Without a PC number, keep the existing footer-driven behavior.
  if (!pc && !prefix && !existingPrefix) return null;
  const next = `${pc ? pc + '｜' : ''}${prefix}${base}`;
  return next === custom ? null : next;
}

// 新規セッションは transcript がまだ作られていなくても待機名を返す。
export function sessionStart(input, { readFile = fs.readFileSync, statSize = p => fs.statSync(p).size, resolvePcNumber: resolveNumber = resolvePcNumber } = {}) {
  try {
    const pc = resolveNumber();
    const file = input?.transcript_path || input?.transcriptPath || '';
    if (!pc || !file || /subagents/i.test(file)) return null;
    let raw = '';
    try {
      if (statSize(file) > MAX_BYTES) return null;
      raw = readFile(file, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') return null; }
    const { custom, ai } = currentTitles(raw);
    if (custom || ai) return null;
    return { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `${pc}｜待機中` } };
  } catch (e) { logError('sessionStart', e); return null; }
}

// 半角は0.5文字として、全角換算30文字までの冒頭を使う。
function promptTitle(prompt) {
  const text = typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
  let title = '', width = 0;
  for (const char of text) {
    width += /[\x20-\x7e\uff61-\uff9f]/.test(char) ? 1 : 2;
    if (width > 60) break;
    title += char;
  }
  return title.trim() || '待機中';
}

// UserPromptSubmit の rename 経路へタイトルを渡す。
export function promptSubmit(input, { readFile = fs.readFileSync, statSize = p => fs.statSync(p).size, resolvePcNumber: resolveNumber = resolvePcNumber, isClosed = isRecordedClosed } = {}) {
  try {
    const pc = resolveNumber();
    const file = input?.transcript_path || input?.transcriptPath || '';
    const sessionId = input?.session_id || input?.sessionId || '';
    if (!pc || !file || !sessionId || /subagents/i.test(file)) return null;
    if (statSize(file) > MAX_BYTES) return null;
    const raw = readFile(file, 'utf8');
    const { custom, ai, customSource } = currentTitles(raw);
    const hasCustom = custom && !isPlaceholder(custom);
    if (!hasCustom && !ai) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: `${pc}｜${promptTitle(input.prompt)}` } };
    // 人の /rename は番号以外を保持し、自動命名だけ期限フッターを反映する。
    const closed = isClosed(sessionId);
    let title = !closed && hasCustom && customSource !== 'orgiast-auto'
      ? custom : desiredTitle(lastAssistantText(raw), raw, pc, closed, sessionId) ?? custom;
    if (!/^\d{3}｜/.test(title)) title = `${pc}｜${title}`;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: title } };
  } catch (e) { logError('promptSubmit', e); return null; }
}

export function apply(input, { readFile = fs.readFileSync, appendFile = fs.appendFileSync, statSize = p => fs.statSync(p).size, resolvePcNumber: resolveNumber = resolvePcNumber, isClosed = isRecordedClosed, reopen = reopenRecordedSession, log = logReopen } = {}) {
  try {
    const file = input?.transcript_path || input?.transcriptPath || '';
    const sessionId = input?.session_id || input?.sessionId || '';
    if (!file || !sessionId || /subagents/i.test(file)) return null;
    if (statSize(file) > MAX_BYTES) return null;
    const raw = readFile(file, 'utf8');
    const text = typeof input?.last_assistant_message === 'string' && input.last_assistant_message.trim() ? input.last_assistant_message : lastAssistantText(raw);
    const closed = isClosed(sessionId);
    if (closed && latestWaitDeadline(text)) {
      try {
        reopen(sessionId);
        log(`reopened ${sessionId}: removed from closed-sessions.json (latest footer has wait deadline)`);
      } catch { /* fail-open: the current wait title must still be applied */ }
    }
    const title = desiredTitle(text, raw, resolveNumber(), closed, sessionId);
    if (!title) return null;
    appendFile(file, `${raw.endsWith('\n') ? '' : '\n'}${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId, source: 'orgiast-auto' })}\n`);
    return title;
  } catch (e) { logError('apply', e); return null; }
}

// 全プロジェクトの transcript に apply を当てる。subagent・古いもの・巨大なものは飛ばす。
export function sweepAll({ base = path.join(os.homedir(), '.claude'), now = Date.now(), force = false, resolvePcNumber: resolveNumber = resolvePcNumber, isClosed = isRecordedClosed } = {}) {
  const stateFile = path.join(base, 'session-wait-title-state.json');
  try { if (!force && now - JSON.parse(fs.readFileSync(stateFile, 'utf8')).at < SWEEP_COOLDOWN_MS) return { skipped: 'cooldown' }; } catch (e) { logError('sweepAll state read', e); }
  try { fs.writeFileSync(stateFile, JSON.stringify({ at: now })); } catch (e) { logError('sweepAll state write', e); }
  const result = { scanned: 0, titled: [] };
  const projects = path.join(base, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return result; }
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(projects, dir.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projects, dir.name, name);
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > RECENT_DAYS * 86400_000) continue;
        result.scanned += 1;
        const title = apply({ transcript_path: file, session_id: name.slice(0, -'.jsonl'.length) }, { resolvePcNumber: resolveNumber, isClosed });
        // PC番号の一括付与で全 transcript の更新日時が今になり、履歴の並び順が崩れるのを防ぐ。
        if (title) { fs.utimesSync(file, stat.atime, stat.mtime); result.titled.push({ session: name.slice(0, 8), title }); }
      } catch (e) { logError(`sweepAll apply ${file}`, e); }
    }
  }
  return result;
}

async function main() {
  try {
    if (process.argv.includes('--all')) {
      const result = sweepAll({ force: process.argv.includes('--force') });
      if (process.argv.includes('--verbose')) console.log(JSON.stringify(result, null, 2));
      return;
    }
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'UserPromptSubmit' || process.argv.includes('--prompt-submit')) {
      const output = input.hook_event_name === 'SessionStart' ? sessionStart(input) : promptSubmit(input);
      if (output) console.log(JSON.stringify(output));
      return;
    }
    apply(input);
  } catch (e) { logError('main', e); /* fail-open */ }
}

if (isEntry(import.meta.url)) { await main(); process.exitCode = 0; }
