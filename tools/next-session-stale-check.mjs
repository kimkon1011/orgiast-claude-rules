#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { readInboxItem } from './kim-inbox.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = 'kimkon1011/orgiast-claude-rules';
export const STATUS_RESOLVED = '完了済み';
export const STATUS_PENDING = '未決';
export const STATUS_PARTIAL = '一部完了';
export const STATUS_UNKNOWN = '判定不能';

const MAIL_RESOLVED = new Set(['delivered', 'seen', 'done', 'expired', 'failed']);
const INBOX_RESOLVED = new Set(['answered', 'done', 'seen']);
const PR_RESOLVED = new Set(['MERGED', 'CLOSED']);
const DELEGATION_RESOLVED = new Set(['resolved']);
/** delegation-health.json がこの日数より古いと台帳停止疑い → 判定不能に倒す */
const DELEGATION_HEALTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isResolvedState(state, from) {
  if (from === 'mail') return MAIL_RESOLVED.has(state);
  if (from === 'inbox') return INBOX_RESOLVED.has(state);
  if (from === 'pr') return PR_RESOLVED.has(state);
  if (from === 'delegation-health') return DELEGATION_RESOLVED.has(state);
  // Auto-detect when caller passes empty from
  if (MAIL_RESOLVED.has(state) || INBOX_RESOLVED.has(state) || PR_RESOLVED.has(state) || DELEGATION_RESOLVED.has(state)) return true;
  return false;
}

export function extractReferences(text) {
  const prNumbers = [], seen = new Set();
  for (const match of text.matchAll(/PR\s*#(\d+)/gi)) {
    const number = Number(match[1]);
    if (!seen.has(number)) prNumbers.push(number), seen.add(number);
  }
  for (const match of text.matchAll(/#(\d+)/g)) {
    const before = match.index === 0 ? '' : text[match.index - 1];
    const number = Number(match[1]);
    if (!/[A-Za-z0-9]/.test(before) && !seen.has(number)) prNumbers.push(number), seen.add(number);
  }
  // 2026-11-27 実測: [delegation-health:lane_outage_unrepaired] が「参照なし」で空振りしていた
  const delegationHealthIds = [...new Set(
    [...text.matchAll(/\[delegation-health:([a-z0-9_]+)\]/g)].map(match => match[1]),
  )];
  // 空のときはキーを出さない（既存 test/ の deepEqual 形を壊さない）
  return {
    prNumbers,
    inboxIds: [...new Set(text.match(/\bki-\d{14}-[0-9a-f]{4}\b/g) ?? [])],
    mailIds: [...new Set(text.match(/\bmail-\d{14}-[0-9a-f]{4}\b/g) ?? [])],
    ...(delegationHealthIds.length ? { delegationHealthIds } : {}),
  };
}

/**
 * delegation-health.json の findings 有無で状態を返す。
 * 台帳欠損・壊損・generatedAt 欠落・7日超は undefined（判定不能側。解決済みと誤判定しない）。
 */
export function resolveDelegationHealthStatus(ledger, id, now = new Date()) {
  if (!ledger || typeof ledger !== 'object') return undefined;
  if (!ledger.generatedAt) return undefined;
  const generatedAt = Date.parse(ledger.generatedAt);
  if (!Number.isFinite(generatedAt)) return undefined;
  if (now.getTime() - generatedAt > DELEGATION_HEALTH_MAX_AGE_MS) return undefined;
  if (!Array.isArray(ledger.findings)) return undefined;
  const present = ledger.findings.some(item => item && item.id === id);
  return present ? 'present' : 'resolved';
}

/** ホーム配下の delegation-health.json を読む。無い・壊れているときは null。 */
export function loadDelegationHealthLedger(home) {
  try {
    const file = path.join(home, '.claude', 'delegation-health.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function classifyLine(line, prStates, inboxStates, mailStates, delegationHealthStates = new Map()) {
  const { prNumbers, inboxIds, mailIds, delegationHealthIds = [] } = extractReferences(line);
  if (prNumbers.length + inboxIds.length + mailIds.length + delegationHealthIds.length === 0) return STATUS_UNKNOWN;
  const states = [
    ...prNumbers.map(n => prStates.get(n)),
    ...inboxIds.map(id => inboxStates.get(id)),
    ...mailIds.map(id => mailStates.get(id)),
    ...delegationHealthIds.map(id => delegationHealthStates.get(id)),
  ];
  const unknown = states.some(s => s === undefined || s === '照会失敗');
  if (unknown) return STATUS_UNKNOWN;
  const resolvedCount = states.filter(s => isResolvedState(s, '')).length;
  if (resolvedCount === states.length) return STATUS_RESOLVED;
  if (resolvedCount > 0) return STATUS_PARTIAL;
  return STATUS_PENDING;
}

const splitLines = text => text.match(/.*(?:\r\n|\n|$)/g).filter(line => line !== '');
const lineBody = line => line.replace(/\r?\n$/, '');

export function findTodoRows(text) {
  const lines = splitLines(text);
  const heading = lines.findIndex(line => /^## 残TODO\s*$/.test(lineBody(line)));
  if (heading < 0) return { lines, rows: [] };
  let end = lines.length;
  for (let index = heading + 1; index < lines.length; index++) {
    if (/^##\s+/.test(lineBody(lines[index]))) { end = index; break; }
  }
  const rows = [];
  for (let index = heading + 1; index < end; index++) {
    if (/^\s*\d+\.\s+/.test(lineBody(lines[index]))) rows.push({ index, lineNumber: index + 1, text: lineBody(lines[index]) });
  }
  return { lines, rows };
}

export function rebuildDocument(text, removeLineNumbers) {
  const { lines, rows } = findTodoRows(text);
  const remove = new Set(removeLineNumbers), rowIndices = new Set(rows.map(row => row.index));
  let number = 0;
  return lines.flatMap((line, index) => {
    if (!rowIndices.has(index)) return [line];
    if (remove.has(index + 1)) return [];
    return [line.replace(/^(\s*)\d+(\.\s+)/, `$1${++number}$2`)];
  }).join('');
}

export function rebuildTodos(lines, removeIndices) {
  const remove = new Set(removeIndices);
  let number = 0;
  return lines.flatMap((line, index) => remove.has(index) ? [] : [line.replace(/^(\s*)\d+(\.\s+)/, (_, a, b) => `${a}${++number}${b}`)]);
}

async function fetchPrState(number, repo) {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergedAt'], { timeout: 20_000, windowsHide: true });
    const value = JSON.parse(stdout);
    return value.mergedAt ? 'MERGED' : value.state;
  } catch { return '照会失敗'; }
}

function resolveMailStatus(state) {
  if (!state) return '照会失敗';
  // mail-*.json の status は fleet-inbox の lifecycle: delivered/seen/done/expired/failed/new
  return MAIL_RESOLVED.has(state) ? state : 'pending';
}

function reasonFor(refs, prStates, inboxStates, mailStates, delegationHealthStates = new Map()) {
  const delegationHealthIds = refs.delegationHealthIds ?? [];
  const failed = [
    ...refs.prNumbers.filter(n => prStates.get(n) === '照会失敗').map(n => `PR #${n}`),
    ...refs.inboxIds.filter(id => inboxStates.get(id) === '照会失敗'),
    ...refs.mailIds.filter(id => mailStates.get(id) === '照会失敗'),
    ...delegationHealthIds.filter(id => {
      const state = delegationHealthStates.get(id);
      return state === undefined || state === '照会失敗';
    }).map(id => `delegation-health:${id}`),
  ];
  if (failed.length) return `${failed.join('、')} の照会失敗`;
  const states = [
    ...refs.prNumbers.map(n => `PR #${n}=${prStates.get(n)}`),
    ...refs.inboxIds.map(id => `${id}=${inboxStates.get(id)}`),
    ...refs.mailIds.map(id => `${id}=${mailStates.get(id)}`),
    ...delegationHealthIds.map(id => `delegation-health:${id}=${delegationHealthStates.get(id)}`),
  ];
  return states.length ? states.join('、') : '参照なし';
}

/**
 * 部分完了行に付ける注釈を生成する。
 * 解決済みの参照だけを列挙する。
 */
export function partialNotes(line, prStates, inboxStates, mailStates, delegationHealthStates = new Map()) {
  const refs = extractReferences(line);
  const done = [];
  for (const n of refs.prNumbers) {
    if (isResolvedState(prStates.get(n), 'pr')) done.push(`PR #${n}`);
  }
  for (const id of refs.inboxIds) {
    if (isResolvedState(inboxStates.get(id), 'inbox')) done.push(id);
  }
  for (const id of refs.mailIds) {
    if (isResolvedState(mailStates.get(id), 'mail')) done.push(id);
  }
  for (const id of refs.delegationHealthIds ?? []) {
    if (isResolvedState(delegationHealthStates.get(id), 'delegation-health')) done.push(`delegation-health:${id}`);
  }
  return done.length ? `（部分完了: ${done.join('、')}）` : '';
}

/** fleet-inbox から mail-... JSON を読み、status を返す。無ければ undefined。 */
function readMailItemStatus(home, id) {
  try {
    const file = path.join(home, '.claude', 'fleet-inbox', `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed?.status || undefined;
  } catch { return '照会失敗'; }
}

/**
 * 番号付きリスト行の末尾に注釈を追記したソースを返す。
 * partialMap: key=text（行本文）, value=注釈文字列（例: '（部分完了: PR #123）'）
 */
export function annotatePartials(text, partialMap) {
  return splitLines(text).map(line => {
    const body = lineBody(line);
    const note = partialMap.get(body);
    return note ? `${body}  ${note}\n` : line;
  }).join('');
}

function parseArgs(args) {
  const options = { file: path.join(os.homedir(), '.claude', 'next-session.md'), repo: DEFAULT_REPO, apply: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') options.apply = true;
    else if (args[index] === '--file' && args[index + 1]) options.file = path.resolve(args[++index]);
    else if (args[index] === '--repo' && args[index + 1]) options.repo = args[++index];
    else throw new Error(`不明または値のないオプション: ${args[index]}`);
  }
  return options;
}

function backupName(file, now = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(now).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return path.join(path.dirname(file), `next-session.md.bak.${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`);
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); } catch (error) { console.error(error.message); return 2; }
  let source;
  try { source = fs.readFileSync(options.file, 'utf8'); } catch (error) { console.error(`読み取り失敗: ${options.file} (${error.message})`); return 1; }
  const { rows } = findTodoRows(source), refsByRow = rows.map(row => extractReferences(row.text));
  const home = os.homedir();
  const prStates = new Map();
  for (const number of new Set(refsByRow.flatMap(refs => refs.prNumbers))) prStates.set(number, await fetchPrState(number, options.repo));
  const inboxStates = new Map();
  for (const id of new Set(refsByRow.flatMap(refs => refs.inboxIds))) {
    try { inboxStates.set(id, readInboxItem(home, id)?.status ?? '照会失敗'); } catch { inboxStates.set(id, '照会失敗'); }
  }
  const mailStates = new Map();
  for (const id of new Set(refsByRow.flatMap(refs => refs.mailIds))) {
    mailStates.set(id, resolveMailStatus(readMailItemStatus(home, id)));
  }
  const delegationLedger = loadDelegationHealthLedger(home);
  const delegationHealthStates = new Map();
  for (const id of new Set(refsByRow.flatMap(refs => refs.delegationHealthIds ?? []))) {
    const state = resolveDelegationHealthStatus(delegationLedger, id);
    if (state !== undefined) delegationHealthStates.set(id, state);
  }
  const results = rows.map((row, index) => ({
    ...row, status: classifyLine(row.text, prStates, inboxStates, mailStates, delegationHealthStates),
    reason: reasonFor(refsByRow[index], prStates, inboxStates, mailStates, delegationHealthStates),
  }));
  for (const result of results) console.log(`行${result.lineNumber} / ${result.status} / ${result.reason}`);
  if (!rows.length) console.log('対象の番号付きリスト行はありません。');
  const completed = results.filter(result => result.status === STATUS_RESOLVED);
  const partials = results.filter(result => result.status === STATUS_PARTIAL);
  if (options.apply && (completed.length || partials.length)) {
    const backup = backupName(options.file);
    fs.copyFileSync(options.file, backup);
    const partialMap = new Map();
    for (const row of partials) {
      const note = partialNotes(row.text, prStates, inboxStates, mailStates, delegationHealthStates);
      if (note) partialMap.set(row.text, note);
    }
    let modified = source;
    if (partialMap.size) modified = annotatePartials(modified, partialMap);
    if (completed.length) modified = rebuildDocument(modified, completed.map(result => result.lineNumber));
    fs.writeFileSync(options.file, modified, 'utf8');
    console.log(`バックアップ: ${backup}`);
    for (const result of completed) console.log(`削除: ${result.text}`);
    for (const result of partials) {
      const note = partialNotes(result.text, prStates, inboxStates, mailStates, delegationHealthStates);
      console.log(`注釈: ${result.text}  → ${note}`);
    }
  } else if (!options.apply) {
    console.log(`dry-run: 削除候補 ${completed.length} 行、注釈候補 ${partials.length} 行（ファイルは変更していません）`);
  }
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();