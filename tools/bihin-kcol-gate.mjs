#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"bihin-kcol-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"bihin-kcol-gate"}]};
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout as readStdin } from './lib/hook-stdin.mjs';

export const SPREADSHEET_ID = '1QCW86DIri6nryqheFKw8Cr6e9Ce0YRV6FvFFW0zqBnc';
export const SHEET_ID = 935442052;
export const FORMULA = '=ArrayFormula(IF(E4:E="","",E4:E-J4:J))';
export const HOOK_MATCHER = 'mcp__.*Google_Sheets__(update_values|append_values|update_formulas|batch_clear_values|update_spreadsheet|batch_update)$|Bash|PowerShell';
const MCP = /^mcp__.*Google_Sheets__(update_values|append_values|update_formulas|batch_clear_values|update_spreadsheet|batch_update)$/;
const REASON = '[BIHIN-KCOL] 備品管理表（全体）「備品在庫管理表」の K列（現在在庫数）は K4 の ArrayFormula が自動計算する列です。K5 以降に値を入れると全備品の在庫表示が消えます（2026-10-22 事故・担当者依頼）。在庫数は E列「倉庫在庫数」に入れ、K を跨ぐ書き込みは C:J と L:N の2範囲に分けるか、K 位置を null にしてください。';
const column = s => [...s.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const normalize = s => String(s).replace(/\s/g, '').toLowerCase();

export function parseRange(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('!');
  if (parts.length > 2) return null;
  if (parts.length === 2 && parts[0].replace(/^'|'$/g, '') !== '備品在庫管理表') return null;
  const a1 = parts.at(-1).replace(/\$/g, '');
  const match = /^([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?$/i.exec(a1);
  if (!match || !a1 || a1 === ':') return null;
  const [, c1, r1, c2, r2] = match;
  const hasEnd = a1.includes(':');
  return {
    startColumn: c1 ? column(c1) : 1,
    endColumn: hasEnd ? (c2 ? column(c2) : Infinity) : (c1 ? column(c1) : Infinity),
    startRow: r1 ? Number(r1) : 1,
    endRow: hasEnd ? (r2 ? Number(r2) : Infinity) : (r1 ? Number(r1) : Infinity),
  };
}
const containsK = r => r && r.startColumn <= 11 && r.endColumn >= 11;
function writesK(item, operation) {
  const r = parseRange(item.range);
  if (!containsK(r)) return false;
  if (operation === 'batch_clear_values') return r.startRow <= 4 && r.endRow >= 4;
  const values = item.values ?? item.formulas;
  if (!Array.isArray(values)) return false;
  const offset = 11 - r.startColumn;
  const cells = item.majorDimension === 'COLUMNS'
    ? (Array.isArray(values[offset]) ? values[offset] : [])
    : values.map(row => Array.isArray(row) ? row[offset] : undefined);
  return cells.some((value, row) => {
    if (value == null) return false;
    // Append has no known destination row and cannot restore K4 safely.
    return !(operation !== 'append_values' && r.startColumn === 11 && r.endColumn === 11
      && r.startRow === 4 && r.endRow === 4 && row === 0 && normalize(value) === normalize(FORMULA));
  });
}
const targetGrid = r => r && Number(r.sheetId) === SHEET_ID
  && (r.startColumnIndex ?? r.columnIndex ?? 0) <= 10 && (r.endColumnIndex ?? Infinity) > 10;
const valueFields = fields => typeof fields === 'string' && (fields.split(',').some(s => s.trim() === '*') || /\buserEnteredValue\b/.test(fields));
function requestWritesK(request) {
  if (!request || typeof request !== 'object') return false;
  for (const kind of ['updateCells', 'repeatCell', 'appendCells']) {
    const op = request[kind];
    if (op && valueFields(op.fields) && targetGrid(op.range ?? op.start ?? op)) return true;
  }
  for (const kind of ['pasteData', 'copyPaste', 'cutPaste']) {
    const op = request[kind];
    if (!op) continue;
    const pasteType = op.pasteType ?? op.type ?? 'PASTE_NORMAL';
    if (['PASTE_FORMAT', 'PASTE_DATA_VALIDATION', 'PASTE_CONDITIONAL_FORMATTING', 'PASTE_COLUMN_WIDTHS'].includes(pasteType)) continue;
    if (targetGrid(op.destination ?? op.coordinate)) return true;
  }
  const find = request.findReplace;
  return Boolean(find && (find.allSheets === true || Number(find.sheetId) === SHEET_ID || targetGrid(find.range)));
}

export function shellWritesK(text) {
  if (!text.includes(SPREADSHEET_ID)
    || !/(?:values:batchUpdate|:append|method\s*:\s*['"]PUT['"]|batchUpdate|setValues?\b|update_values)/.test(text)) return false;
  const ranges = /備品在庫管理表'?!\$?([A-Z]{1,2})(?:\$?\d+|\$\{[^}]*\})?(?::\$?([A-Z]{1,2})(?:\$?\d+|\$\{[^}]*\})?)?/g;
  return [...text.matchAll(ranges)].some(m => column(m[1]) <= 11 && column(m[2] ?? m[1]) >= 11);
}

// File I/O stays outside judge. Read at most 200 KiB; unreadable/dynamic paths fail open.
export function readScriptText(command, cwd) {
  const scripts = /\b(?:node|python(?:3)?)(?:\.exe)?\s+(?:"([^"\r\n]+\.(?:mjs|js|py))"|'([^'\r\n]+\.(?:mjs|js|py))'|([^\s;&|]+\.(?:mjs|js|py)))(?=\s|$|[;&|])/g;
  const texts = [];
  for (const match of command.matchAll(scripts)) {
    let fd;
    try {
      const file = path.resolve(cwd, match[1] ?? match[2] ?? match[3]);
      if (!fs.statSync(file).isFile()) continue;
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(200 * 1024);
      texts.push(buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'));
    } catch { /* fail-open */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return texts.join('\n');
}

export function judge(input, { env = {}, scriptText = '' } = {}) {
  if (env.BIHIN_KCOL_GATE_SKIP === '1') return { deny: false, skipped: true };
  const tool = input?.tool_name ?? '';
  const args = input?.tool_input ?? {};
  let deny = false;
  if (tool === 'Bash' || tool === 'PowerShell') {
    deny = shellWritesK(`${args.command ?? ''}\n${scriptText}`);
  } else {
    const operation = MCP.exec(tool)?.[1];
    if (!operation || args.spreadsheetId !== SPREADSHEET_ID) return { deny: false };
    const body = args.body ?? args;
    if (operation === 'update_spreadsheet' || operation === 'batch_update') {
      deny = Array.isArray(body.requests) && body.requests.some(requestWritesK);
    } else if (operation === 'batch_clear_values') {
      const ranges = body.ranges ?? (body.range ? [body.range] : []);
      deny = Array.isArray(ranges) && ranges.some(range => writesK({ range }, operation));
    } else {
      const data = Array.isArray(body.data) ? body.data : [body];
      deny = data.some(item => item && writesK({ majorDimension: body.majorDimension, ...item }, operation));
    }
  }
  return deny ? { deny: true, reason: REASON } : { deny: false };
}

export function selftest() {
  const input = (op, args) => ({ tool_name: `mcp__test_Google_Sheets__${op}`, tool_input: { spreadsheetId: SPREADSHEET_ID, ...args } });
  const row = Array(12).fill(null); row[8] = '1';
  const cases = [
    ['values K', input('update_values', { range: '備品在庫管理表!C4194:N4194', values: [row] }), true],
    ['append K', input('append_values', { range: 'A:N', values: [[...Array(10).fill(null), 1]] }), true],
    ['clear K', input('batch_clear_values', { ranges: ['K:K'] }), true],
    ['clear K4', input('batch_clear_values', { ranges: ['K4:K4'] }), true],
    ['cells K', input('batch_update', { requests: [{ updateCells: { range: { sheetId: SHEET_ID, startColumnIndex: 10, endColumnIndex: 11 }, fields: 'userEnteredValue' } }] }), true],
    ['shell script text', { tool_name: 'Bash', tool_input: { command: 'node scratch.mjs' } }, true, `${SPREADSHEET_ID} values:batchUpdate 備品在庫管理表!C\${row}:N\${row}`],
    ['null K', input('update_values', { range: 'C4194:N4194', values: [Array(12).fill(null)] }), false],
    ['C:J', input('update_values', { range: 'C:J', values: [row] }), false],
    ['L:N', input('update_values', { range: 'L:N', values: [[1]] }), false],
    ['other sheet', input('update_values', { range: '別シート!C:N', values: [row] }), false],
    ['other spreadsheet', input('update_values', { spreadsheetId: 'other', range: 'C:N', values: [row] }), false],
    ['clear spill', input('batch_clear_values', { ranges: ['K5:K'] }), false],
    ['restore', input('update_formulas', { range: 'K4', formulas: [[FORMULA]] }), false],
    ['format', input('batch_update', { requests: [{ repeatCell: { range: { sheetId: SHEET_ID }, fields: 'userEnteredFormat' } }] }), false],
    ['read', input('get_values', { range: 'K:K' }), false],
  ];
  return cases.flatMap(([name, event, expected, scriptText]) => judge(event, { scriptText }).deny === expected ? [] : [name]);
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const command = String(input?.tool_input?.command ?? '');
    const scriptText = /^(Bash|PowerShell)$/.test(input?.tool_name ?? '')
      ? readScriptText(command, input.cwd || process.cwd()) : '';
    const result = judge(input, { env: process.env, scriptText });
    if (result.skipped) process.stderr.write('[BIHIN-KCOL] BIHIN_KCOL_GATE_SKIP=1 により確認を省略しました（緊急用）。\n');
    if (result.deny) console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason,
    } }));
  } catch { /* fail-open: malformed input or inaccessible script */ }
}
if (isEntry(import.meta.url)) {
  if (process.argv.includes('--selftest')) {
    const failures = selftest();
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
    else console.log('bihin-kcol-gate selftest ok');
  } else await main();
}
