#!/usr/bin/env node
// 社用車の車検満了を毎朝監視し、kim と管理担当へ通知して更新完了まで追いかける。
// 実行例: node tools/vehicle-inspection-watch.mjs [--dry-run] [--now YYYY-MM-DD] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { closeKey, dropItem, listItems } from './kim-inbox.mjs';
import { isEntry } from './is-entry.mjs';
import { createSheetsClient, quoteTab } from './lib/sheets-dwd.mjs';

const execFileAsync = promisify(execFile);
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const RANGE = 'A1:O10000';

export const HEADERS = ['車両ID', '車名', '登録番号', '会社', '管理担当', '保管場所', '車検満了日', '車検証', '状態', '依頼先', '入庫予定日', '次回満了日', '最終通知日', '通知回数', '備考'];
export const REQUIRED_HEADERS = ['車両ID', '車名', '登録番号', '車検満了日', '状態'];
export const STAGES = [90, 60, 45, 30, 21, 14, 7, 3, 1, 0];
export const BOOKED_STATUSES = ['予約済', '入庫中'];
export const CHASING_STATUSES = ['未手配', '見積依頼中'];
export const CLOSED_STATUS = '売却済';
export const DONE_STATUS = '完了';
const BOOKED_STAGES = [14, 3, 0];

export function parseArgs(argv) {
  const args = { dryRun: false, json: false, now: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--now') {
      const value = argv[i + 1];
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new Error('--now は YYYY-MM-DD で指定してください');
      }
      args.now = value;
      i += 1;
    } else throw new Error(`不明な引数です: ${argv[i]}`);
  }
  return args;
}

export function jstDate(now = new Date()) {
  return new Date(new Date(now).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

// 台帳の日付は YYYY-MM-DD 文字列か、UNFORMATTED_VALUE のシリアル値（1899-12-30 起点）で来る。
export function parseSheetDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const days = Math.floor(value);
    if (days < 1) return null;
    return new Date(Date.UTC(1899, 11, 30) + days * DAY).toISOString().slice(0, 10);
  }
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

export function daysUntil(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

export function decideNotification({ remainingDays, status }) {
  if (remainingDays < 0) return { notify: true, stage: remainingDays };
  if (BOOKED_STATUSES.includes(status)) {
    if (remainingDays > 30) return { notify: STAGES.includes(remainingDays), stage: remainingDays };
    return { notify: BOOKED_STAGES.includes(remainingDays), stage: remainingDays };
  }
  if (CHASING_STATUSES.includes(status) && remainingDays <= 30) return { notify: true, stage: remainingDays };
  return { notify: STAGES.includes(remainingDays), stage: remainingDays };
}

export function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function parseRows(values) {
  const header = (values[0] ?? []).map((value) => String(value ?? '').trim());
  const columns = new Map(header.map((name, index) => [name, index]));
  const missing = REQUIRED_HEADERS.filter((name) => !columns.has(name));
  if (missing.length) throw new Error(`車検台帳の見出しが足りません: ${missing.join(', ')}`);
  const cell = (row, name) => (columns.has(name) ? row[columns.get(name)] : '');
  const text = (row, name) => String(cell(row, name) ?? '').trim();
  const rows = [];
  for (let i = 1; i < values.length; i += 1) {
    const raw = values[i] ?? [];
    const id = text(raw, '車両ID');
    if (!id) continue;
    rows.push({
      rowNumber: i + 1,
      id,
      name: text(raw, '車名'),
      plate: text(raw, '登録番号'),
      company: text(raw, '会社'),
      assignee: text(raw, '管理担当'),
      location: text(raw, '保管場所'),
      expiry: parseSheetDate(cell(raw, '車検満了日')),
      status: text(raw, '状態') || '未手配',
      vendor: text(raw, '依頼先'),
      scheduled: parseSheetDate(cell(raw, '入庫予定日')) ?? '',
      nextExpiry: parseSheetDate(cell(raw, '次回満了日')),
      notifyCount: Number(cell(raw, '通知回数') ?? 0) || 0,
      columns,
    });
  }
  return rows;
}

function nextAction(status, remainingDays) {
  if (remainingDays < 0) return '公道走行不可。積載車か仮ナンバーの手配が必要';
  if (status === '未手配') return '整備工場3社へ見積依頼を Claude が出します。依頼先の指定があれば返信してください';
  if (status === '見積依頼中') return '見積の返信を確認し、最安・最短の案を出します';
  if (status === '予約済') return '入庫日を忘れずに';
  if (status === '入庫中') return '入庫中の整備状況を確認します';
  return '状態を台帳で確認してください';
}

export function notificationBody({ row, remainingDays, sheetId }) {
  const when = remainingDays < 0 ? `${-remainingDays}日超過` : `あと${remainingDays}日`;
  return [
    `【車検】${row.name}（${row.plate}）満了 ${row.expiry}（${when}）`,
    `状態: ${row.status} ／ 依頼先: ${row.vendor || '未定'} ／ 入庫予定: ${row.scheduled || '未定'}`,
    `次の一手: ${nextAction(row.status, remainingDays)}`,
    `台帳: https://docs.google.com/a/orgiast.jp/spreadsheets/d/${sheetId}/edit`,
  ].join('\n');
}

export function missingNextExpiryBody(row, sheetId) {
  return [
    `【車検】${row.name}（${row.plate}）は更新完了ですが、新しい車検証の満了日が台帳に入っていません`,
    '次回満了日を台帳に入れてください。入るまで毎日お知らせします。',
    `台帳: https://docs.google.com/a/orgiast.jp/spreadsheets/d/${sheetId}/edit`,
  ].join('\n');
}

export function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

async function withBodyFile(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vehicle-inspection-'));
  const file = path.join(dir, 'body.txt');
  fs.writeFileSync(file, body, { mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function retireVehicleAsks(home, row) {
  if (!row.name || !row.plate) return;
  for (const item of listItems(home, { status: 'open' })) {
    if (item.kind === 'ask' && item.source === 'vehicle-inspection' && item.text.startsWith(`【車検】${row.name}（${row.plate}）`)) dropItem(home, item.id, '期限レーンに移行');
  }
}

export async function defaultNotifyKim({ home, kind, body, key, due, remainingDays, row }) {
  if (kind === 'deadline') body = `${remainingDays <= 3 ? '🔴' : remainingDays <= 14 ? '🟠' : '🟡'} ${key} ${body.replace(/[\r\n]+/g, '｜')}`;
  const result = await withBodyFile(body, (file) => execFileAsync(process.execPath, [
    path.join(toolsDir, 'kim-inbox.mjs'), '--add', '--kind', kind,
    ...(kind === 'deadline' ? ['--key', key, ...(due ? ['--due', due] : []), ...(remainingDays !== undefined ? ['--remaining-days', String(remainingDays)] : [])] : []),
    '--source', 'vehicle-inspection', '--body-file', file,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, ORGIAST_HOME: home } }));
  if (row && kind === 'deadline') retireVehicleAsks(home, row);
  return result;
}

export async function defaultNotifyStaff({ home, assignee, body }) {
  const script = path.join(toolsDir, 'discord-dm.mjs');
  if (!fs.existsSync(script)) {
    const error = new Error('no route');
    error.code = 'NO_ROUTE';
    throw error;
  }
  return withBodyFile(body, (file) => execFileAsync(process.execPath, [
    script, assignee, '--body-file', file,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, ORGIAST_HOME: home } }));
}

async function locateRow({ sheets, sheetId, tab, id }) {
  const rows = parseRows(await sheets.get(sheetId, `${quoteTab(tab)}!${RANGE}`));
  return rows.find((row) => row.id === id) ?? null;
}

async function writeCells({ sheets, sheetId, tab, row, changes }) {
  for (const [name, value] of Object.entries(changes)) {
    const index = row.columns.get(name);
    if (index === undefined) continue;
    await sheets.update(sheetId, `${quoteTab(tab)}!${columnLetter(index)}${row.rowNumber}`, [[value]]);
  }
}

async function recordNotification({ sheets, sheetId, tab, row, today }) {
  const fresh = await locateRow({ sheets, sheetId, tab, id: row.id });
  if (!fresh) throw new Error('台帳で車両IDの行が見つかりません');
  await writeCells({ sheets, sheetId, tab, row: fresh, changes: { 最終通知日: today, 通知回数: fresh.notifyCount + 1 } });
}

function decision(row, action, reason, remainingDays = null) {
  return {
    vehicleId: row.id,
    name: row.name,
    plate: row.plate,
    status: row.status,
    expiry: row.expiry ?? '',
    remainingDays,
    action,
    reason,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(`vehicle-inspection: ${error.message}`);
    return 1;
  }

  const configFile = path.join(home, '.claude', 'vehicle-inspection', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    stderr(`vehicle-inspection: 設定を読めません (${configFile}): ${error.code === 'ENOENT' ? '設定なし' : error.message}`);
    return 2;
  }
  if (!config || typeof config.sheetId !== 'string' || !config.sheetId.trim()) {
    stderr(`vehicle-inspection: 設定に sheetId がありません (${configFile})`);
    return 2;
  }
  const sheetId = config.sheetId.trim();
  const tab = String(config.tab || '車検台帳');
  const stateFile = path.join(home, '.claude', 'vehicle-inspection', 'state.json');
  const today = args.now ?? jstDate(deps.now ? deps.now() : new Date());
  const sheets = deps.sheets ?? createSheetsClient();
  const notifyKim = deps.notifyKim ?? defaultNotifyKim;
  const notifyStaff = deps.notifyStaff ?? defaultNotifyStaff;

  let state;
  try {
    state = loadState(stateFile);
  } catch (error) {
    stderr(`vehicle-inspection: state を読めません: ${error.message}`);
    return 1;
  }

  let rows;
  try {
    rows = parseRows(await sheets.get(sheetId, `${quoteTab(tab)}!${RANGE}`));
  } catch (error) {
    stderr(`vehicle-inspection: 台帳を読めません: ${error.message}`);
    return 1;
  }

  const decisions = [];
  const errors = [];
  let stateChanged = false;
  let notified = 0;

  for (const row of rows) {
    if (row.status === CLOSED_STATUS) {
      if (!args.dryRun) closeKey(home, row.id);
      decisions.push(decision(row, 'skip', '売却済'));
      continue;
    }

    if (row.status === DONE_STATUS) {
      if (row.nextExpiry) {
        decisions.push(decision(row, 'rollover', `次回満了日 ${row.nextExpiry}`));
        if (args.dryRun) continue;
        try {
          const fresh = await locateRow({ sheets, sheetId, tab, id: row.id });
          if (!fresh) throw new Error('台帳で車両IDの行が見つかりません');
          await writeCells({
            sheets, sheetId, tab, row: fresh,
            changes: { 車検満了日: row.nextExpiry, 次回満了日: '', 状態: '未手配', 依頼先: '', 入庫予定日: '' },
          });
          closeKey(home, row.id);
          await notifyKim({ home, kind: 'info', body: `${row.name} の車検更新を記録しました。次の満了日 ${row.nextExpiry}` });
          notified += 1;
        } catch (error) {
          errors.push(`${row.id}: ${error.message}`);
        }
        continue;
      }
      if (state[row.id]?.lastNotifiedDate === today) {
        decisions.push(decision(row, 'skip', '同日通知済み'));
        continue;
      }
      decisions.push(decision(row, 'ask-next-expiry', '次回満了日が空'));
      if (args.dryRun) continue;
      try {
        await notifyKim({ home, kind: 'deadline', key: row.id, row, remainingDays: -1, body: missingNextExpiryBody(row, sheetId) });
        await recordNotification({ sheets, sheetId, tab, row, today });
        state[row.id] = { lastNotifiedDate: today, lastStage: null };
        stateChanged = true;
        notified += 1;
      } catch (error) {
        errors.push(`${row.id}: ${error.message}`);
      }
      continue;
    }

    if (!row.expiry) {
      decisions.push(decision(row, 'skip', '車検満了日なし'));
      continue;
    }
    const remainingDays = daysUntil(today, row.expiry);
    const verdict = decideNotification({ remainingDays, status: row.status });
    if (!verdict.notify) {
      decisions.push(decision(row, 'skip', '段階外', remainingDays));
      continue;
    }
    if (state[row.id]?.lastNotifiedDate === today) {
      decisions.push(decision(row, 'skip', '同日通知済み', remainingDays));
      continue;
    }
    decisions.push(decision(row, 'notify', `段階 ${verdict.stage}`, remainingDays));
    if (args.dryRun) continue;
    try {
      const body = notificationBody({ row, remainingDays, sheetId });
      await notifyKim({ home, kind: 'deadline', key: row.id, due: row.expiry, remainingDays, row, body });
      if (row.assignee) {
        try {
          await notifyStaff({ home, assignee: row.assignee, body });
        } catch (error) {
          stderr(error.code === 'NO_ROUTE' ? 'staff-notify: skipped (no route)' : `staff-notify: failed (${error.message})`);
        }
      } else {
        stderr('staff-notify: skipped (no assignee)');
      }
      await recordNotification({ sheets, sheetId, tab, row, today });
      state[row.id] = { lastNotifiedDate: today, lastStage: verdict.stage };
      stateChanged = true;
      notified += 1;
    } catch (error) {
      errors.push(`${row.id}: ${error.message}`);
    }
  }

  if (!args.dryRun && stateChanged) {
    try {
      saveState(stateFile, state);
    } catch (error) {
      errors.push(`state: ${error.message}`);
    }
  }

  for (const error of errors) stderr(`vehicle-inspection: ${error}`);

  if (args.json) {
    stdout(JSON.stringify({ today, sheetId, tab, dryRun: args.dryRun, notified, decisions, errors }, null, 2));
  } else {
    stdout(`${today} 車検: 通知 ${notified}件 / 判定 ${decisions.length}件${args.dryRun ? ' (dry-run)' : ''}`);
    for (const item of decisions) {
      const days = item.remainingDays === null ? '' : ` あと${item.remainingDays}日`;
      stdout(`  [${item.action}] ${item.vehicleId} ${item.name}（${item.plate}）${days} ${item.reason}`);
    }
  }
  return errors.length ? 1 : 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
