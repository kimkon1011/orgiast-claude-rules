#!/usr/bin/env node
import { rowToTask, taskToRow, formatJst } from './discord-task-digest.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULT_SHEET_ID = '1WtsSiDlId8EgyzA15pJbeCGfvMHUgBqrUMmucax4A24';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const ACTIVE_STATES = new Set(['未着手', '進行中', '保留']);
const ACTIONS = new Map([
  ['start', { status: '進行中', result: '着手', memoRequired: false }],
  ['done', { status: '完了', result: '完了', memoRequired: true }],
  ['reject', { status: '却下', result: '却下', memoRequired: true }],
  ['defer', { status: '保留', result: '保留', memoRequired: true }],
]);

class CliError extends Error {
  constructor(message, exitCode = 2) { super(message); this.exitCode = exitCode; }
}

export function parseArgs(argv) {
  const opts = { sheet: process.env.DISCORD_TASK_SHEET_ID?.trim() || DEFAULT_SHEET_ID, actor: 'Claude', top: 10, rank: '', json: false, dryRun: false, memo: '' };
  const commands = new Set(['list', 'show', ...ACTIONS.keys()]);
  const valued = new Set(['sheet', 'actor', 'top', 'rank', 'memo']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (!arg.startsWith('--')) throw new CliError(`不正な引数です: ${arg}`);
    const name = arg.slice(2);
    if (commands.has(name)) {
      if (opts.command) throw new CliError('操作は1つだけ指定してください');
      opts.command = name;
      if (name !== 'list') {
        const id = argv[i + 1];
        if (!id || id.startsWith('--')) throw new CliError(`--${name} にはIDを指定してください`);
        opts.id = id; i++;
      }
      continue;
    }
    if (!valued.has(name) || argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new CliError(`不正な引数です: ${arg}`);
    opts[name] = argv[++i];
  }
  if (!opts.command) throw new CliError('--list、--show、--start、--done、--reject、--defer のいずれかを指定してください');
  opts.top = Number(opts.top);
  if (!Number.isInteger(opts.top) || opts.top < 1) throw new CliError('--top は正の整数で指定してください');
  if (opts.rank && !/^P[1-4]$/.test(opts.rank)) throw new CliError('--rank は P1〜P4 で指定してください');
  const action = ACTIONS.get(opts.command);
  if (action?.memoRequired && !String(opts.memo).trim()) throw new CliError(`--${opts.command} には --memo が必須です`);
  return opts;
}

function valuesUrl(sheetId, range) {
  return `${SHEETS_API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
}

async function sheetsRequest(fetchImpl, token, url, init = {}) {
  const response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`Sheets API エラー: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

function listLine(task) {
  return `${task.id}  ${task.rank}  ${task.score}  ${task.type}  ${task.title}  期限:${task.deadline || '-'}  @${task.channelName}`;
}

function showText(task) {
  const labels = [
    ['ID', 'id'], ['起票日', 'createdAt'], ['優先ランク', 'rank'], ['優先度スコア', 'score'], ['種別', 'type'],
    ['タイトル', 'title'], ['具体アクション', 'action'], ['担当', 'owner'], ['期限', 'deadline'], ['チャンネル', 'channelName'],
    ['根拠', 'evidence'], ['Discordリンク', 'link'], ['状態', 'status'], ['実行メモ', 'memo'], ['最終更新', 'updatedAt'],
  ];
  return labels.map(([label, key]) => `${label}: ${task[key] ?? ''}`).join('\n');
}

function appendMemo(existing, added) {
  const before = String(existing || '').trim(), after = String(added || '').trim();
  return before && after ? `${before} / ${after}` : before || after;
}

export async function runDiscordTaskExec(options = {}) {
  const opts = { ...parseArgs(options.args || []), ...(options.cli || {}) };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const log = options.log || console.log;
  const token = await (options.getToken || getDriveToken)({ scope: SHEETS_SCOPE });
  const all = await sheetsRequest(fetchImpl, token, valuesUrl(opts.sheet, 'タスク!A2:O'));
  const rows = Array.isArray(all.values) ? all.values : [];
  const tasks = rows.map(rowToTask);

  if (opts.command === 'list') {
    const selected = tasks.filter((task) => ACTIVE_STATES.has(task.status) && (!opts.rank || task.rank === opts.rank)).slice(0, opts.top);
    if (opts.json) log(JSON.stringify(selected));
    else for (const task of selected) log(listLine(task));
    return selected;
  }

  const index = tasks.findIndex((task) => task.id === opts.id);
  if (index < 0) throw new CliError(`ID「${opts.id}」のタスクが見つかりません`);
  const task = tasks[index];
  if (opts.command === 'show') { log(showText(task)); return task; }

  const action = ACTIONS.get(opts.command);
  const rowNumber = index + 2;
  if (task.status === action.status) {
    log(`変更なし: ${task.id} はすでに「${action.status}」です`);
    const result = { ok: true, id: task.id, from: task.status, to: action.status, row: rowNumber, logged: false };
    log(JSON.stringify(result));
    return result;
  }

  const updated = { ...task, status: action.status, memo: appendMemo(task.memo, opts.memo), updatedAt: formatJst(options.now || new Date()) };
  const converted = taskToRow(updated);
  const row = Array.from({ length: 15 }, (_, column) => column < 12 ? (rows[index][column] ?? '') : converted[column]);
  const taskRange = `タスク!A${rowNumber}:O${rowNumber}`;
  const logRow = [updated.updatedAt, task.id, task.title, opts.actor, action.result, String(opts.memo || '').trim()];
  if (opts.dryRun) {
    const result = { ok: true, dryRun: true, id: task.id, from: task.status, to: action.status, row: rowNumber, taskRange, values: row, logRange: '実行ログ!A:F', logValues: logRow };
    log(JSON.stringify(result));
    return result;
  }

  await sheetsRequest(fetchImpl, token, `${valuesUrl(opts.sheet, taskRange)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: taskRange, majorDimension: 'ROWS', values: [row] }),
  });
  const appendUrl = `${valuesUrl(opts.sheet, '実行ログ!A:F')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await sheetsRequest(fetchImpl, token, appendUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: '実行ログ!A:F', majorDimension: 'ROWS', values: [logRow] }),
  });
  const verified = await sheetsRequest(fetchImpl, token, valuesUrl(opts.sheet, taskRange));
  const actual = rowToTask(verified.values?.[0] || []);
  if (actual.id !== task.id || actual.status !== action.status) {
    throw new Error(`書き込み検証に失敗しました: ID ${actual.id || 'なし'}/${task.id}、状態 ${actual.status || 'なし'}/${action.status}`);
  }
  const result = { ok: true, id: task.id, from: task.status, to: action.status, row: rowNumber, logged: true };
  log(JSON.stringify(result));
  return result;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  try { await runDiscordTaskExec({ ...options, args: argv }); return 0; }
  catch (error) { (options.error || console.error)(`discord-task-exec: ${error.message}`); return error.exitCode || 1; }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
