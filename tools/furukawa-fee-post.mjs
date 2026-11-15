#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';

// ---------------------------------------------------------------------------
// Pure functions (exported for unit testing)
// ---------------------------------------------------------------------------

export function monthTabName(y, m) {
  return `${y}年${m}月`;
}

export function prevMonth(y, m) {
  if (m === 1) return { y: y - 1, m: 12 };
  return { y, m: m - 1 };
}

export function monthEndString(y, m) {
  const d = new Date(y, m, 0); // day 0 of month m = last day of month m
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${y}/${mm}/${dd}`;
}

/**
 * Build a task row object for the fee post.
 * Keys are spreadsheet column letters; values are the cell content.
 */
export function buildTaskRow({ y, m, amount, gid }) {
  return {
    A: '金功勇',
    B: '学会関連',
    C: `業務委託報酬 ${y}年${m}月分（古川未歩）`,
    E: monthEndString(y, m),
    H: '古川未歩',
    J: amount,
    L: `金額は月次計算シート「${monthTabName(y, m)}」タブの今月の支払額から自動計上`,
    M: `https://docs.google.com/spreadsheets/d/1hyJAbXGzsWgtNpCpj5Gon3fA3yGKOkD3Dy9tOOK6L3c/edit#gid=${gid}`,
    U: '✔︎',
  };
}

/**
 * Find the next empty row in the task sheet (A5:U data).
 * Returns the 1-indexed row number to write at.
 * rows is the raw 2D array from the sheet API (each sub-array index 0=A, 1=B, …).
 */
export function findAppendRow(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    if (r[0] || r[1] || r[2]) {
      return 5 + i + 1; // next after last occupied row
    }
  }
  return 5; // all empty, start at header+1
}

/**
 * Decide what to do when posting a fee row.
 *
 * @param {object} params
 * @param {Array<Array<string|null>>} params.rows - A5:U data (0-based within the range, row number = i+5)
 * @param {object} params.item - { C, H, y, m } — target column-C value, column-H value, year, month for posted key
 * @param {number} params.amount - Amount from the monthly calc sheet (I30)
 * @param {object|null} params.posted - State file contents { posted: { [YYYY-MM]: { row, amount, at } } }
 * @returns {object} { type: 'append'|'update'|'none', row?: number }
 */
export function decideAction({ rows, item, amount, posted }) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const cVal = String(r[2] ?? '');
    const hVal = String(r[7] ?? '');
    if (cVal === item.C && hVal === item.H) {
      const jVal = r[9];
      const pVal = r[15]; // 検収 column
      // P empty (falsy) AND J differs → update
      if (!pVal && toNumber(jVal) !== amount) {
        return { type: 'update', row: i + 5 };
      }
      // Otherwise (P non-empty OR J same) → none
      return { type: 'none', row: i + 5 };
    }
  }
  // Not found
  const monthKey = `${item.y}-${String(item.m).padStart(2, '0')}`;
  if (posted && posted.posted && posted.posted[monthKey]) {
    return { type: 'none' };
  }
  return { type: 'append' };
}

/**
 * Safely convert a value that may be a comma-formatted string or number to a number.
 */
function toNumber(v) {
  if (v == null) return NaN;
  return Number(String(v).replace(/,/g, ''));
}

// ---------------------------------------------------------------------------
// Helpers for Sheets API (used in main flow)
// ---------------------------------------------------------------------------

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getSheetsMeta(token, spreadsheetId) {
  const res = await driveApi(token, `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
  const data = await res.json();
  return data.sheets.map(s => s.properties);
}

async function readRange(token, spreadsheetId, range, renderOption) {
  let url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  if (renderOption) url += `?valueRenderOption=${renderOption}`;
  const res = await driveApi(token, url);
  const data = await res.json();
  return data.values ?? [];
}

async function writeRange(token, spreadsheetId, range, values) {
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const body = JSON.stringify({ values, majorDimension: 'ROWS' });
  const res = await driveApi(token, url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return res.json();
}

async function batchUpdateValues(token, spreadsheetId, data) {
  const url = `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`;
  const body = JSON.stringify({ valueInputOption: 'USER_ENTERED', data });
  const res = await driveApi(token, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return res.json();
}

async function sheetsBatchUpdate(token, spreadsheetId, requests) {
  const url = `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`;
  const body = JSON.stringify({ requests });
  const res = await driveApi(token, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// State file helpers
// ---------------------------------------------------------------------------

function stateFilePath() {
  return path.join(os.homedir(), '.claude', 'state', 'furukawa-fee-post.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
  } catch {
    return { posted: {} };
  }
}

function writeState(state) {
  const fp = stateFilePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, fp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// kim-inbox helper
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function notifyInbox(text) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fee-post-'));
  const bodyFile = path.join(tmpDir, 'body.txt');
  try {
    fs.writeFileSync(bodyFile, text, 'utf8');
    const result = spawnSync(process.execPath, [
      path.join(__dirname, 'kim-inbox.mjs'),
      '--add', '--body-file', bodyFile, '--kind', 'info', '--source', 'furukawa-fee-post',
    ], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ORGIAST_HOME: home },
    });
    if (result.status !== 0) {
      console.error(`kim-inbox notification failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const MONTHLY_CALC_ID = '1hyJAbXGzsWgtNpCpj5Gon3fA3yGKOkD3Dy9tOOK6L3c';
const TASK_SHEET_ID = '1BTSkpcOLZ8F869vnNqPulyvbaZ1Ou7InjH5jsJH4grA';
const TASK_TAB = 'task';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function parseDate(str) {
  const m = String(str ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function todayAsiaTokyo() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600000);
  return { y: jst.getUTCFullYear(), m: jst.getUTCMonth() + 1, d: jst.getUTCDate() };
}

// Convert a buildTaskRow result into a 21-element array for batch write.
// G and Q are skipped per spec.
function taskRowToArray(rowObj) {
  const arr = new Array(21).fill(null);
  arr[0] = rowObj.A;  // A
  arr[1] = rowObj.B;  // B
  arr[2] = rowObj.C;  // C
  arr[3] = '';        // D
  arr[4] = rowObj.E;  // E
  arr[5] = '';        // F
  // G — do NOT write
  arr[7] = rowObj.H;  // H
  arr[8] = '';        // I
  arr[9] = rowObj.J;  // J
  arr[10] = '';       // K
  arr[11] = rowObj.L; // L
  arr[12] = rowObj.M; // M
  arr[13] = '';       // N
  arr[14] = '';       // O
  // P — do NOT write (left for manual 検収)
  // Q — do NOT write
  arr[17] = '';       // R
  arr[18] = '';       // S
  arr[19] = '';       // T
  arr[20] = rowObj.U; // U
  return arr;
}

export async function main(args = process.argv.slice(2)) {
  const nowIdx = args.indexOf('--now');
  const nowStr = nowIdx !== -1 ? args[nowIdx + 1] : null;
  const dryRun = args.includes('--dry-run');
  const today = nowStr ? parseDate(nowStr) : todayAsiaTokyo();
  if (!today) {
    console.error('--now の形式が不正です (YYYY-MM-DD)');
    process.exit(1);
  }

  const { y, m, d } = today;

  // ---- Get auth token ----
  let token;
  try {
    token = await getDriveToken({ scope: SCOPE, impersonate: 'kim@orgiast.jp' });
  } catch (err) {
    console.error(`認証エラー: ${err.message}`);
    process.exit(1);
  }

  const dryLog = [];

  // === Phase 1: Ensure this month's tab exists in the monthly calc sheet ===
  const calcSheets = await getSheetsMeta(token, MONTHLY_CALC_ID);
  const monthTabRegex = /^\d{4}年\d{1,2}月$/;
  const monthSheets = calcSheets
    .filter(s => monthTabRegex.test(s.title))
    .sort((a, b) => a.index - b.index);

  const thisMonthName = monthTabName(y, m);
  let thisMonthSheet = monthSheets.find(s => s.title === thisMonthName);

  if (!thisMonthSheet) {
    if (monthSheets.length === 0) {
      const msg = `月次計算シートに月タブが1つも見つかりません`;
      if (dryRun) { dryLog.push({ tabCreated: null, error: msg }); console.log(JSON.stringify(dryLog, null, 2)); return; }
      console.error(msg); notifyInbox(msg); process.exit(1);
    }
    const newest = monthSheets[monthSheets.length - 1];
    const insertIndex = newest.index + 1;

    if (dryRun) {
      dryLog.push({ tabCreated: { name: thisMonthName, duplicatedFrom: newest.title } });
    } else {
      try {
        await sheetsBatchUpdate(token, MONTHLY_CALC_ID, [{
          duplicateSheet: {
            sourceSheetId: newest.sheetId,
            insertSheetIndex: insertIndex,
            newSheetName: thisMonthName,
          },
        }]);
      } catch (err) {
        const msg = `月タブ複製エラー: ${err.message}`;
        console.error(msg); notifyInbox(msg); process.exit(1);
      }

      // Reset cells for the new tab
      try {
        await writeRange(token, MONTHLY_CALC_ID, `'${thisMonthName}'!A1`, [[`古川未歩さん 業務委託報酬 月次計算（${thisMonthName}分）`]]);
        await writeRange(token, MONTHLY_CALC_ID, `'${thisMonthName}'!B3`, [[`'${thisMonthName}`]]);
        const resetG = Array.from({ length: 14 }, () => [0]);
        const resetJ = Array.from({ length: 14 }, () => ['']);
        await batchUpdateValues(token, MONTHLY_CALC_ID, [
          { range: `'${thisMonthName}'!G15:G28`, values: resetG },
          { range: `'${thisMonthName}'!J15:J28`, values: resetJ },
        ]);
      } catch (err) {
        const msg = `月タブ初期化エラー: ${err.message}`;
        console.error(msg); notifyInbox(msg); process.exit(1);
      }

      const refreshed = await getSheetsMeta(token, MONTHLY_CALC_ID);
      thisMonthSheet = refreshed.find(s => s.title === thisMonthName);
    }
  }

  // === Phase 2: Post previous month's fee (only on day 1-7) ===
  if (d < 1 || d > 7) {
    const result = { phase: 'post-previous', action: 'skipped', reason: `今日は${d}日。1〜7日以外は計上しません` };
    if (dryRun) dryLog.push(result);
    else console.log(JSON.stringify(result));
  } else {
    const prev = prevMonth(y, m);
    const prevName = monthTabName(prev.y, prev.m);

    const allSheets = await getSheetsMeta(token, MONTHLY_CALC_ID);
    const prevSheet = allSheets.find(s => s.title === prevName);
    if (!prevSheet) {
      const msg = `前月タブ「${prevName}」が見つかりません（計算シートに未作成の可能性）`;
      if (dryRun) { dryLog.push({ phase: 'post-previous', error: msg }); }
      else { console.error(msg); notifyInbox(msg); process.exit(1); }
    }

    // Read A30 and I30 with UNFORMATTED_VALUE
    const summaryRow = await readRange(token, MONTHLY_CALC_ID, `'${prevName}'!A30:I30`, 'UNFORMATTED_VALUE');
    const a30 = summaryRow[0]?.[0] ?? '';
    const i30 = summaryRow[0]?.[8];

    if (!String(a30).startsWith('今月の支払額')) {
      const msg = `前月タブ「${prevName}」の A30 が「今月の支払額」で始まりません（構造が変わった可能性）: "${a30}"`;
      if (dryRun) { dryLog.push({ phase: 'post-previous', error: msg }); }
      else { console.error(msg); notifyInbox(msg); process.exit(1); }
    }
    const amount = Number(i30);
    if (!Number.isFinite(amount)) {
      const msg = `前月タブ「${prevName}」の I30 が数値ではありません: ${JSON.stringify(i30)}`;
      if (dryRun) { dryLog.push({ phase: 'post-previous', error: msg }); }
      else { console.error(msg); notifyInbox(msg); process.exit(1); }
    }

    // Dry-run: if any error was logged above, output and stop before doing real work
    if (dryRun && dryLog.some(e => e.phase === 'post-previous' && e.error)) {
      console.log(JSON.stringify(dryLog, null, 2));
      return;
    }

    const prevY = prev.y, prevM = prev.m;
    const taskRow = buildTaskRow({ y: prevY, m: prevM, amount, gid: prevSheet.sheetId });

    const existingRows = await readRange(token, TASK_SHEET_ID, `'${TASK_TAB}'!A5:U`, 'UNFORMATTED_VALUE');
    const state = readState();
    const action = decideAction({ rows: existingRows, item: { C: taskRow.C, H: taskRow.H, y: prevY, m: prevM }, amount, posted: state });

    if (dryRun) {
      dryLog.push({
        phase: 'post-previous',
        action: action.type,
        row: action.row ?? (action.type === 'append' ? findAppendRow(existingRows) : null),
        month: `${prevY}-${String(prevM).padStart(2, '0')}`,
        amount,
      });
    } else {
      if (action.type === 'none') {
        console.log(JSON.stringify({ action: 'none', reason: `行は既存 (row=${action.row}) または posted 済み` }));
      } else if (action.type === 'update') {
        try {
          await writeRange(token, TASK_SHEET_ID, `'${TASK_TAB}'!J${action.row}`, [[amount]]);
        } catch (err) {
          const msg = `金額更新エラー (row=${action.row}): ${err.message}`;
          console.error(msg); notifyInbox(msg); process.exit(1);
        }
        // Read back and verify
        const readback = await readRange(token, TASK_SHEET_ID, `'${TASK_TAB}'!C${action.row}:J${action.row}`, 'UNFORMATTED_VALUE');
        const rbRow = readback[0] ?? [];
        // C:J range → C=0, D=1, E=2, F=3, G=4, H=5, I=6, J=7
        if (String(rbRow[0] ?? '').trim() !== taskRow.C || String(rbRow[5] ?? '').trim() !== taskRow.H || toNumber(rbRow[7]) !== amount) {
          const msg = `金額更新の読み戻し不一致 (row=${action.row}): C="${rbRow[0]}" H="${rbRow[5]}" J="${rbRow[7]}"`;
          console.error(msg); notifyInbox(msg); process.exit(1);
        }
        const monthKey = `${prevY}-${String(prevM).padStart(2, '0')}`;
        const newState = { posted: { ...state.posted, [monthKey]: { row: action.row, amount, at: new Date().toISOString() } } };
        writeState(newState);
        notifyInbox(`【古川未歩 業務委託報酬】${prevY}年${prevM}月分 ${amount.toLocaleString()}円をタスク台帳の${action.row}行目に更新しました。\nタスク台帳: https://docs.google.com/spreadsheets/d/${TASK_SHEET_ID}/edit?authuser=kim@orgiast.jp`);
        console.log(JSON.stringify({ action: 'update', row: action.row, amount }));
      } else if (action.type === 'append') {
        const appendRow = findAppendRow(existingRows);
        const rowArr = taskRowToArray(taskRow);
        try {
          await batchUpdateValues(token, TASK_SHEET_ID, [
            { range: `'${TASK_TAB}'!A${appendRow}:E${appendRow}`, values: [[rowArr[0], rowArr[1], rowArr[2], rowArr[3], rowArr[4]]] },
            { range: `'${TASK_TAB}'!H${appendRow}`, values: [[rowArr[7]]] },
            { range: `'${TASK_TAB}'!J${appendRow}`, values: [[rowArr[9]]] },
            { range: `'${TASK_TAB}'!L${appendRow}:M${appendRow}`, values: [[rowArr[11], rowArr[12]]] },
            { range: `'${TASK_TAB}'!U${appendRow}`, values: [[rowArr[20]]] },
          ]);
        } catch (err) {
          const msg = `行追加エラー (row=${appendRow}): ${err.message}`;
          console.error(msg); notifyInbox(msg); process.exit(1);
        }
        // Read back and verify
        const readback = await readRange(token, TASK_SHEET_ID, `'${TASK_TAB}'!A${appendRow}:U${appendRow}`, 'UNFORMATTED_VALUE');
        const rbRow = readback[0] ?? [];
        if (String(rbRow[2] ?? '').trim() !== taskRow.C || String(rbRow[7] ?? '').trim() !== taskRow.H || toNumber(rbRow[9]) !== amount) {
          const msg = `行追加の読み戻し不一致 (row=${appendRow}): C="${rbRow[2]}" H="${rbRow[7]}" J="${rbRow[9]}"`;
          console.error(msg); notifyInbox(msg); process.exit(1);
        }
        const monthKey = `${prevY}-${String(prevM).padStart(2, '0')}`;
        const newState = { posted: { ...state.posted, [monthKey]: { row: appendRow, amount, at: new Date().toISOString() } } };
        writeState(newState);
        notifyInbox(`【古川未歩 業務委託報酬】${prevY}年${prevM}月分 ${amount.toLocaleString()}円をタスク台帳の${appendRow}行目に追加しました。\nタスク台帳: https://docs.google.com/spreadsheets/d/${TASK_SHEET_ID}/edit?authuser=kim@orgiast.jp`);
        console.log(JSON.stringify({ action: 'append', row: appendRow, amount }));
      }
    }
  }

  if (dryRun) {
    console.log(JSON.stringify(dryLog, null, 2));
  }
}

if (isEntry(import.meta.url)) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}