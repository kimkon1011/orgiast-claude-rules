#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchGmail } from './gmail-search.mjs';
import { createLlmClient, PROVIDERS } from './line-digest.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { mergeTasks, taskToRow, sortTasks } from './discord-task-digest.mjs';
import { isEntry } from './is-entry.mjs';

const DEFAULT_USER = 'seisaku-team@orgiast.jp';
const DEFAULT_SHEET_ID = '1WtsSiDlId8EgyzA15pJbeCGfvMHUgBqrUMmucax4A24';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TYPES = new Set(['改善', 'タスク', '締切', '決定待ち', 'リスク']);

// from、subject、body を改行で連結した文字列へ個別に適用する。配列の各条件を単体テスト可能に保つ。
export const MAIL_NOISE_PATTERNS = [
  /^from:.*info-membership@/imu,
  /^from:.*mailmagazine/imu,
  /^from:.*\bnews@/imu,
  /^subject:.*(?:【PR】|【広告】)/imu,
  /^(?=[\s\S]*^subject:.*(?:【セミナー】|【ご案内】))(?=[\s\S]*配信停止)/imu,
];

function mailText(message) {
  return `from:${message?.from || ''}\nsubject:${message?.subject || ''}\nbody:${message?.body || ''}`;
}

export function preprocessMails(messages) {
  const latest = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!String(message?.body || '').replace(/[\s\u00a0]+/gu, '')) continue;
    if (MAIL_NOISE_PATTERNS.some((pattern) => pattern.test(mailText(message)))) continue;
    const threadId = String(message?.threadId || message?.id || '');
    if (!threadId) continue;
    const prior = latest.get(threadId);
    const time = Date.parse(message?.date || '') || 0;
    const priorTime = Date.parse(prior?.date || '') || 0;
    if (!prior || time >= priorTime) latest.set(threadId, message);
  }
  return [...latest.values()];
}

export function gmailThreadLink(user, threadId) {
  return `https://mail.google.com/mail/u/${String(user)}/#all/${String(threadId)}`;
}

function displayName(from) {
  const value = String(from || '').trim();
  const before = value.match(/^\s*"?([^"<]+?)"?\s*</u)?.[1]?.trim();
  return before || value.match(/<?([^@<\s]+)@/u)?.[1] || value || '差出人不明';
}

function parseItems(raw) {
  const clean = String(raw ?? '').replace(/```(?:json)?/giu, '').replace(/```/gu, '').replace(/,\s*([}\]])/gu, '$1');
  const start = clean.indexOf('{');
  if (start < 0) return null;
  for (let end = clean.length; end > start; end--) {
    try {
      const value = JSON.parse(clean.slice(start, end));
      if (Array.isArray(value?.items)) return value.items;
    } catch {}
  }
  return null;
}

function normalizedDateParts(deadline) {
  const match = String(deadline).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return [];
  const [, y, m, d] = match;
  return [deadline, `${Number(m)}月${Number(d)}日`, `${m}月${d}日`, `${Number(m)}/${Number(d)}`, `${m}/${d}`, `${y}/${m}/${d}`];
}

export function validatedDeadline(deadline, message) {
  const value = String(deadline || '');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return '';
  const body = String(message?.body || '');
  const hasBodyBasis = normalizedDateParts(value).some((part) => body.includes(part))
    || /(?:提出期限|返信期限|振込期日|お支払期限|支払期限|締切|明日|明後日|今週中|本日中|今日中)/u.test(body);
  return hasBodyBasis ? value : '';
}

const COMPLETION_END = /(?:拝受いたしました|受領(?:いた)?しました|お振込みが完了|振込(?:み)?(?:が)?完了|対応(?:が)?完了|ありがとうございました|ありがとうございます)[\s。！!]*$/u;

export function validateExtractedItem(item, batch, user) {
  const index = Number(item?.i), message = batch[index];
  if (!Number.isInteger(index) || !message || !TYPES.has(item?.type)) return null;
  const title = String(item.title || '').trim().slice(0, 40);
  const action = String(item.action || '').trim();
  if (!title || !action || COMPLETION_END.test(String(message.body || '').trim())) return null;
  return {
    type: item.type, title, action, owner: String(item.owner || '').trim(),
    deadline: validatedDeadline(item.deadline, message),
    urgency: Math.max(0, Math.min(3, Number(item.urgency) || 0)),
    impact: Math.max(0, Math.min(3, Number(item.impact) || 0)),
    evidence: String(item.evidence || '').trim().slice(0, 120),
    channelId: String(message.threadId), channelName: `✉ ${displayName(message.from)}`,
    messageId: String(message.id || ''), link: gmailThreadLink(user, message.threadId),
  };
}

const SYSTEM_PROMPT = 'メールから未完了の実行事項だけを抽出する。JSONオブジェクトのみを返し、説明・コードフェンスは禁止。形式は {"items":[{"i":<入力番号>,"type":"改善|タスク|締切|決定待ち|リスク","title":"40字以内","action":"誰が何をするかを1文","owner":"本文で名指しされた担当者のみ。無ければ空文字","deadline":"YYYY-MM-DD または空","urgency":0-3,"impact":0-3,"evidence":"本文からの抜粋120字以内"}]}。「提出期限」「返信期限」「振込期日」「お支払期限」「締切」を最優先で拾う。件名の期日は古い可能性があるため本文の日付を優先し、件名だけが根拠ならdeadlineは空にする。完了・受領・御礼（拝受いたしました、お振込みが完了、ありがとうございました等）で終わるスレッドはitemsに入れない。送信専用アドレスでも差戻し・エラー・支払い不成立は「リスク」として拾う。明日・今週中などは各メールのreceivedAtを基準に解決してよい。担当者や根拠を推測しない。該当なしは {"items":[]}。';

export async function extractMailTasks(messages, { user, provider, llm }) {
  const items = []; let held = 0;
  for (let offset = 0; offset < messages.length; offset += 8) {
    const batch = messages.slice(offset, offset + 8);
    const prompt = batch.map((message, i) => JSON.stringify({ i, receivedAt: message.date, from: message.from, subject: message.subject, body: message.body })).join('\n');
    let parsed = null;
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      const response = await llm({ provider, messages: [{ role: 'system', content: attempt ? `${SYSTEM_PROMPT} 前回はJSONとして解釈できなかった。` : SYSTEM_PROMPT }, { role: 'user', content: prompt }], responseFormat: { type: 'json_object' } });
      parsed = parseItems(response.text);
    }
    if (parsed === null) { held += batch.length; continue; }
    for (const raw of parsed) {
      const item = validateExtractedItem(raw, batch, user);
      if (item) items.push(item);
    }
  }
  return { items, held };
}

function parseArgs(argv) {
  const opts = { user: DEFAULT_USER, since: 2, max: 60, sheet: process.env.DISCORD_TASK_SHEET_ID?.trim() || DEFAULT_SHEET_ID, provider: 'groq', dryRun: false, fixture: '', noLlm: false };
  const valued = new Set(['user', 'since', 'max', 'sheet', 'provider', 'fixture']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--no-llm') { opts.noLlm = true; continue; }
    if (!arg.startsWith('--') || !valued.has(arg.slice(2)) || argv[i + 1] == null) throw new Error(`不正な引数: ${arg}`);
    opts[arg.slice(2)] = argv[++i];
  }
  opts.since = Number(opts.since); opts.max = Number(opts.max);
  if (!Number.isInteger(opts.since) || opts.since < 1) throw new Error('--since は正の整数で指定してください');
  if (!Number.isInteger(opts.max) || opts.max < 1) throw new Error('--max は正の整数で指定してください');
  if (!PROVIDERS[opts.provider] || !['groq', 'deepseek', 'gemini'].includes(opts.provider)) throw new Error('--provider は groq、deepseek、gemini のいずれかを指定してください');
  return opts;
}

async function sheetsRequest(fetchImpl, token, url, init = {}) {
  const response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`Sheets API エラー: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function valuesUrl(sheetId, range) {
  return `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
}

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value?.messageIds) ? value.messageIds.map(String) : [];
  } catch { return []; }
}

export async function runMailTaskDigest(options = {}) {
  const opts = { ...parseArgs(options.args || []), ...(options.cli || {}) };
  const now = options.now || new Date(), home = options.home || os.homedir();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const stateFile = path.join(home, '.claude', 'mail-tasks', 'state.json');
  const processed = new Set(readState(stateFile));
  let source;
  if (opts.fixture) source = JSON.parse(fs.readFileSync(opts.fixture, 'utf8'));
  else source = await (options.search || searchGmail)({ user: opts.user, query: `newer_than:${opts.since}d -from:no-reply -from:noreply -from:comments-noreply -category:promotions -category:social`, max: opts.max, withBody: true, bodyLimit: 3000 });
  const fetched = Array.isArray(source?.messages) ? source.messages.length : 0;
  const prepared = preprocessMails(source?.messages || []).filter((message) => !processed.has(String(message.id)));
  const llm = options.llm || (opts.noLlm ? null : createLlmClient({ home, fetchImpl, usageFile: path.join(home, '.claude', 'executor-usage.jsonl') }));
  const extracted = opts.noLlm || !prepared.length ? { items: [], held: 0 } : await extractMailTasks(prepared, { user: opts.user, provider: opts.provider, llm });
  let existingRows = options.existingRows || [], token = '';
  if (!opts.dryRun && !options.existingRows) {
    token = await (options.getToken || getDriveToken)({ scope: SHEETS_SCOPE });
    const read = await sheetsRequest(fetchImpl, token, valuesUrl(opts.sheet, 'タスク!A2:O'));
    existingRows = Array.isArray(read.values) ? read.values : [];
  }
  const merged = mergeTasks(existingRows, extracted.items, { now });
  const rows = sortTasks(merged.tasks).map(taskToRow);
  if (opts.dryRun) (options.log || console.log)(JSON.stringify({ rows }));
  else {
    const writeCount = Math.max(existingRows.length, rows.length);
    if (writeCount > 0) {
      const range = `タスク!A2:O${writeCount + 1}`;
      const values = [...rows, ...Array.from({ length: writeCount - rows.length }, () => Array(15).fill(''))];
      await sheetsRequest(fetchImpl, token, `${valuesUrl(opts.sheet, range)}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values }) });
      const verified = await sheetsRequest(fetchImpl, token, valuesUrl(opts.sheet, range));
      const actual = (verified.values || []).filter((row) => row.some((cell) => String(cell || '').trim()));
      if (actual.length !== rows.length || String(actual[0]?.[0] || '') !== String(rows[0]?.[0] || '')) throw new Error(`書き込み検証に失敗しました: 行数 ${actual.length}/${rows.length}、先頭ID ${actual[0]?.[0] || 'なし'}/${rows[0]?.[0] || 'なし'}`);
    }
    const messageIds = [...readState(stateFile), ...prepared.map((message) => String(message.id))].filter(Boolean).slice(-5000);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ lastRunAt: now.toISOString(), messageIds }, null, 2)}\n`);
  }
  const result = { ok: true, user: opts.user, fetched, afterFilter: prepared.length, extracted: extracted.items.length, added: merged.added.length, suppressed: merged.suppressed, held: extracted.held, totalRows: rows.length, top: merged.tasks.slice(0, 5).map(({ id, rank, title }) => ({ id, rank, title })) };
  (options.log || console.log)(JSON.stringify(result));
  (options.log || console.log)(`mail-task-digest: 取得${fetched}通 / 新規${merged.added.length}件 / P1 ${merged.tasks.filter((task) => task.rank === 'P1').length}件`);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  try { await runMailTaskDigest({ args: argv }); return 0; }
  catch (error) { console.error(`mail-task-digest: ${error.message}`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
