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
export const STATUS_UNKNOWN = '判定不能';

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
  return { prNumbers, inboxIds: [...new Set(text.match(/\bki-\d{14}-[0-9a-f]{4}\b/g) ?? [])] };
}

export function classifyLine(line, prStates, inboxStates) {
  const { prNumbers, inboxIds } = extractReferences(line);
  if (prNumbers.length + inboxIds.length === 0) return STATUS_UNKNOWN;
  const states = [...prNumbers.map(number => prStates.get(number)), ...inboxIds.map(id => inboxStates.get(id))];
  if (states.some(state => state === undefined || state === '照会失敗')) return STATUS_UNKNOWN;
  if (states.some(state => state === 'OPEN' || state === 'open' || state === 'pending')) return STATUS_PENDING;
  return STATUS_RESOLVED;
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

function reasonFor(refs, prStates, inboxStates) {
  const failed = [...refs.prNumbers.filter(n => prStates.get(n) === '照会失敗').map(n => `PR #${n}`), ...refs.inboxIds.filter(id => inboxStates.get(id) === '照会失敗')];
  if (failed.length) return `${failed.join('、')} の照会失敗`;
  const states = [...refs.prNumbers.map(n => `PR #${n}=${prStates.get(n)}`), ...refs.inboxIds.map(id => `${id}=${inboxStates.get(id)}`)];
  return states.length ? states.join('、') : '参照なし';
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
  const prStates = new Map();
  for (const number of new Set(refsByRow.flatMap(refs => refs.prNumbers))) prStates.set(number, await fetchPrState(number, options.repo));
  const inboxStates = new Map();
  for (const id of new Set(refsByRow.flatMap(refs => refs.inboxIds))) {
    try { inboxStates.set(id, readInboxItem(os.homedir(), id)?.status ?? '照会失敗'); } catch { inboxStates.set(id, '照会失敗'); }
  }
  const results = rows.map((row, index) => ({ ...row, status: classifyLine(row.text, prStates, inboxStates), reason: reasonFor(refsByRow[index], prStates, inboxStates) }));
  for (const result of results) console.log(`行${result.lineNumber} / ${result.status} / ${result.reason}`);
  if (!rows.length) console.log('対象の番号付きリスト行はありません。');
  const completed = results.filter(result => result.status === STATUS_RESOLVED);
  if (options.apply && completed.length) {
    const backup = backupName(options.file);
    fs.copyFileSync(options.file, backup);
    fs.writeFileSync(options.file, rebuildDocument(source, completed.map(result => result.lineNumber)), 'utf8');
    console.log(`バックアップ: ${backup}`);
    for (const result of completed) console.log(`削除: ${result.text}`);
  } else if (!options.apply) console.log(`dry-run: 削除候補 ${completed.length} 行（ファイルは変更していません）`);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
