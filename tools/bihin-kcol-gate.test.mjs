import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { judge, selftest, readScriptText, HOOK_MATCHER, SPREADSHEET_ID, SHEET_ID, FORMULA } from './bihin-kcol-gate.mjs';
import { rolloutMode } from './gate-runtime.mjs';
import { runHook } from './gate-hook-runner.mjs';
const hook = fileURLToPath(new URL('./bihin-kcol-gate.mjs', import.meta.url));
const event = (operation, args = {}) => ({ tool_name: `mcp__connector_2_Google_Sheets__${operation}`, tool_input: { spreadsheetId: SPREADSHEET_ID, ...args } });
const values = k => [[...Array(8).fill(null), k, 2, 3, 4]];
const run = (input, options = {}) => spawnSync(process.execPath, [hook], {
  input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  env: { ...process.env, BIHIN_KCOL_GATE_SKIP: '' }, ...options,
});
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bihin-kcol-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('selftest covers required deny/allow cases', () => assert.deepEqual(selftest(), []));
for (const value of ['', 0, '1', 1, false]) test(`K value ${JSON.stringify(value)} denies`, () => {
  assert.equal(judge(event('update_values', { range: "'備品在庫管理表'!$C$4194:$N$4194", values: values(value) })).deny, true);
});
for (const value of [null, undefined]) test(`K ${value} allows`, () => {
  assert.equal(judge(event('update_values', { range: 'C4194:N4194', values: values(value) })).deny, false);
});
test('short arrays, column-major writes, multiple ranges and omitted columns', () => {
  assert.equal(judge(event('update_values', { range: 'A:Z', values: [[1]] })).deny, false);
  assert.equal(judge(event('update_values', { range: '4194:4194', values: [[...Array(10).fill(null), 0]] })).deny, true);
  assert.equal(judge(event('update_values', { range: 'J5:L6', majorDimension: 'COLUMNS', values: [[1], [null, 0]] })).deny, true);
  assert.equal(judge(event('update_values', { body: { data: [{ range: 'C:J', values: [[1]] }, { range: 'K5', values: [[1]] }] } })).deny, true);
  assert.equal(judge(event('update_formulas', { range: 'K5', formulas: [['=1']] })).deny, true);
  assert.equal(judge(event('append_values', { range: 'C:N', values: values(1) })).deny, true);
});
test('formula recovery applies only to K4 and never append', () => {
  for (const range of ['K4', "'備品在庫管理表'!K4:K4"]) assert.equal(judge(event('update_values', { range, values: [[FORMULA.toLowerCase().replace('if(', 'if( ')]] })).deny, false);
  for (const range of ['K5', 'K4:K5', 'K:K']) assert.equal(judge(event('update_values', { range, values: [[FORMULA]] })).deny, true);
  assert.equal(judge(event('append_values', { range: 'K4', values: [[FORMULA]] })).deny, true);
  assert.equal(judge(event('update_values', { range: 'K4', values: [['=1']] })).deny, true);
});
test('clear keeps K4 safe and permits clearing the spill', () => {
  for (const range of ['K:K', 'K4:K4', 'A:Z', '4:4', 'J3:L9']) assert.equal(judge(event('batch_clear_values', { ranges: [range] })).deny, true, range);
  for (const range of ['K5:K', 'K1:K3', 'L:N', '別シート!K:K']) assert.equal(judge(event('batch_clear_values', { ranges: [range] })).deny, false, range);
});
const grid = { sheetId: SHEET_ID, startColumnIndex: 10, endColumnIndex: 11 };
for (const request of [
  { updateCells: { range: grid, fields: 'userEnteredValue' } },
  { updateCells: { start: { sheetId: SHEET_ID, columnIndex: 10 }, fields: '*' } },
  { repeatCell: { range: { sheetId: SHEET_ID }, fields: 'userEnteredValue,userEnteredFormat' } },
  { pasteData: { coordinate: { sheetId: SHEET_ID, columnIndex: 10 }, type: 'PASTE_NORMAL' } },
  { copyPaste: { destination: grid } }, { cutPaste: { destination: grid } },
  { appendCells: { sheetId: SHEET_ID, fields: 'userEnteredValue' } },
  { findReplace: { sheetId: SHEET_ID } }, { findReplace: { allSheets: true } },
  { findReplace: { range: grid } },
]) test(`requests deny ${JSON.stringify(request)}`, () => {
  for (const op of ['update_spreadsheet', 'batch_update']) assert.equal(judge(event(op, { requests: [request] })).deny, true);
});
for (const request of [
  { repeatCell: { range: grid, fields: 'userEnteredFormat' } },
  { updateCells: { range: grid, fields: 'note' } },
  { updateCells: { range: { ...grid, sheetId: 42 }, fields: '*' } },
  { repeatCell: { range: { ...grid, endColumnIndex: 10 }, fields: '*' } },
  { repeatCell: { range: { ...grid, startColumnIndex: 11 }, fields: '*' } },
  { copyPaste: { destination: grid, pasteType: 'PASTE_FORMAT' } },
  { cutPaste: { destination: { ...grid, sheetId: 42 } } },
  { findReplace: { range: { ...grid, startColumnIndex: 11 } } },
  { findReplace: { sheetId: 42 } },
]) test(`requests allow ${JSON.stringify(request)}`, () => assert.equal(judge(event('batch_update', { requests: [request] })).deny, false));

test('Bash/PowerShell inspect real node/python files and fail open for missing files', t => {
  const cwd = temp(t);
  const source = `const id = '${SPREADSHEET_ID}'; // values:batchUpdate\nconst range = \`備品在庫管理表!C\${row}:N\${row}\`;`;
  for (const [exe, name] of [['node', 'scratch.mjs'], ['node', 'with spaces.js'], ['python', 'scratch.py']]) {
    fs.writeFileSync(path.join(cwd, name), source);
    for (const tool_name of ['Bash', 'PowerShell']) {
      const input = { tool_name, cwd, tool_input: { command: `${exe} "${name}"` } };
      const result = run(input);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    }
  }
  assert.equal(readScriptText('node missing.mjs', cwd), '');
  fs.writeFileSync(path.join(cwd, 'large.js'), ' '.repeat(200 * 1024) + source);
  assert.equal(readScriptText('node large.js', cwd).length, 200 * 1024);
  assert.equal(judge({ tool_name: 'Bash', tool_input: { command: 'node dynamic.mjs' } }).deny, false);
});
test('shell detection requires ID, write marker and literal target range', () => {
  const command = `${SPREADSHEET_ID} method: 'PUT' 備品在庫管理表!$C$4:$N$4`;
  assert.equal(judge({ tool_name: 'Bash', tool_input: { command } }).deny, true);
  for (const safe of [command.replace(SPREADSHEET_ID, 'other'), command.replace('PUT', 'GET'), command.replace('$C$4:$N$4', '$C$4:$J$4'), command.replace('備品在庫管理表', '別シート')]) assert.equal(judge({ tool_name: 'Bash', tool_input: { command: safe } }).deny, false);
});
test('CLI emits deny reason, logs emergency bypass and fails open on malformed input', () => {
  const input = event('update_values', { range: 'C4194:N4194', values: values('1') });
  const denied = run(input);
  assert.equal(denied.status, 0);
  assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, /\[BIHIN-KCOL\].*C:J.*null/);
  const skipped = run(input, { env: { ...process.env, BIHIN_KCOL_GATE_SKIP: '1' } });
  assert.equal(skipped.status, 0); assert.equal(skipped.stdout, ''); assert.match(skipped.stderr, /BIHIN_KCOL_GATE_SKIP=1/);
  for (const input of ['', '{broken', 'null', '{}', event('get_values', { range: 'K:K' })]) {
    const result = run(input); assert.equal(result.status, 0); assert.equal(result.stdout, '');
  }
});
test('matcher covers connector variants and excludes reads', () => {
  const re = new RegExp(`^(?:${HOOK_MATCHER})$`);
  for (const name of ['mcp__Google_Sheets__update_values', 'mcp__claude_ai_Google_Sheets__batch_update', 'Bash', 'PowerShell']) assert.ok(re.test(name));
  assert.ok(!re.test('mcp__claude_ai_Google_Sheets__get_values'));
});
test('fresh nonpilot PCs deny immediately using shipped manifest', t => {
  assert.equal(rolloutMode('bihin-kcol-gate', { home: temp(t), hostname: 'fresh-offline-pc', now: Date.parse('2026-10-23T00:00:00Z') }), 'deny');
});
test('registered runner preserves denial on a fresh nonpilot PC', async t => {
  const result = await runHook(hook, JSON.stringify(event('update_values', { range: 'C4194:N4194', values: values('1') })), {
    env: { ...process.env, BIHIN_KCOL_GATE_SKIP: '' },
    policyOptions: { home: temp(t), hostname: 'fresh-offline-pc', notify: async () => ({ delivered: 'test' }) },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
