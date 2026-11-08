import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = (file) => fs.readFileSync(new URL(`../gas/fleet-status-sheet/${file}`, import.meta.url), 'utf8');
const ctx = vm.createContext({});
for (const file of ['UpsertLogic.gs','AiCost.gs','AiCostLogic.gs','CloudLedger.gs','CloudLedgerLogic.gs']) vm.runInContext(source(file), ctx);
const summary = [...ctx.AI_COST_SUMMARY_HEADERS_], pending = [...ctx.AI_COST_PENDING_HEADERS_];
const row = (headers, values) => headers.map((header) => values[header] ?? '');
const plain = (value) => JSON.parse(JSON.stringify(value));
const item = { month: '2026-09', service: 'Groq', amount: 20, detectedAt: '2026-10-05', description: 'AI利用料 Groq 2026-09' };
function shuffle(values, seed) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { seed = (seed * 1664525 + 1013904223) >>> 0; const j = seed % (i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
test('200 column orders never write accounting fields, including forced malicious payloads', () => {
  for (let n = 0; n < 200; n++) {
    const headers = shuffle(pending, n + 1), forbidden = ['勘定科目','税区分','登録済み'];
    const payload = { months: ['2026-09'], force: true, rows: [{ ...item, account: 'BAD', tax: 'BAD', registered: 'BAD', 勘定科目: 'BAD', 税区分: 'BAD', 登録済み: 'BAD' }] };
    for (const existing of [[], [row(headers, { 年月: item.month, サービス: item.service })], [row(headers, { 年月: item.month, サービス: item.service, 勘定科目: '人', 税区分: '人', 登録済み: '済' })]]) {
      const plan = ctx.aiCostPlanPendingReplace(headers, existing, payload);
      assert(plan.updates.every((u) => !forbidden.includes(headers[u.columnIndex - 1])));
      for (const output of plan.appendRows) for (const name of forbidden) assert.equal(output[headers.indexOf(name)], '');
    }
  }
});
test('month replacement protects registered and partially entered rows, correcting shifted updates', () => {
  const rows = [row(pending, { 年月: '2026-09', サービス: 'old' }), row(pending, { 年月: '2026-09', サービス: 'Groq', 登録済み: '済', 検出日: 'old' }), row(pending, { 年月: '2026-08', サービス: 'old' }), row(pending, { 年月: '2026-09', サービス: 'manual', 税区分: '入力中' })];
  const plan = ctx.aiCostPlanPendingReplace(pending, rows, { months: ['2026-09'], rows: [item] });
  assert.deepEqual(plain(plan.deleteRowNumbers), [2]);
  assert.equal(plan.appendRows.length, 0);
  assert(plan.updates.every((u) => u.rowNumber === 2));
  assert.equal(plan.updates.find((u) => pending[u.columnIndex - 1] === '検出日').value, item.detectedAt);
  const empty = ctx.aiCostPlanPendingReplace(pending, rows, { months: ['2026-09'], rows: [] });
  assert.deepEqual(plain(empty.deleteRowNumbers), [2]);
});
test('timestamps always refresh, other machine values need force, notes never written', () => {
  const existing = row(summary, { 年月: '2026-09', サービス: 'Groq', '実測利用額(円)': 9, 備考: '人のメモ', '更新日時(JST)': 'old' });
  for (const force of [false, true]) {
    const plan = ctx.aiCostPlanSummaryUpsert(summary, [existing], { force, rows: [{ ...item, localJpy: 20, updatedAt: 'new', notes: 'BAD', 備考: 'BAD' }] });
    const values = Object.fromEntries(plan.updates.map((u) => [summary[u.columnIndex - 1], u.value]));
    assert.equal(values['更新日時(JST)'], 'new');
    assert.equal(values['実測利用額(円)'], force ? 20 : undefined);
    assert(!Object.hasOwn(values, '備考'));
    assert(!Object.hasOwn(values, 'freee計上額(円)'));
  }
  const machine = row(pending, { 年月: item.month, サービス: item.service, '金額(円)': 9, 検出日: 'old' });
  const plan = ctx.aiCostPlanPendingReplace(pending, [machine], { months: [item.month], rows: [item] });
  assert.equal(plan.appendRows[0][pending.indexOf('検出日')], item.detectedAt);
  assert.equal(plan.appendRows[0][pending.indexOf('金額(円)')], 9);
});
test('summary inserts by compound key and rejects duplicates; explicit null differs from omission', () => {
  const plan = ctx.aiCostPlanSummaryUpsert(summary, [], { rows: [{ ...item, localJpy: null }] });
  assert.equal(plan.appendRows[0][summary.indexOf('実測利用額(円)')], '');
  assert.throws(() => ctx.aiCostPlanSummaryUpsert(summary, [], { rows: [item, item] }), /duplicate/);
  assert.throws(() => ctx.aiCostPlanPendingReplace(pending, [], { months: ['2026-08'], rows: [item] }), /outside/);
});
test('describe is read-only and returns only keys and monetary values; lock contention is busy', () => {
  let released = 0;
  const data = { 'AI費用サマリ': { headers: summary, rows: [row(summary, { 年月: item.month, サービス: item.service, 'freee計上額(円)': 123, '支払い元(名義)': 'SECRET', 備考: 'SECRET' })] }, 'freee登録待ち': { headers: pending, rows: [row(pending, { 年月: item.month, サービス: item.service, 勘定科目: 'SECRET' })] } };
  ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'existing-id' }) };
  ctx.LockService = { getScriptLock: () => ({ tryLock: (ms) => { assert.equal(ms, 20000); return true; }, releaseLock: () => released++ }) };
  ctx.SpreadsheetApp = { openById: () => ({ getSheetByName: (name) => ({ getLastRow: () => 2, getLastColumn: () => data[name].headers.length, getRange: (r) => ({ getDisplayValues: () => [data[name].headers], getValues: () => data[name].rows }) }) }) };
  const description = ctx.describeAiCost();
  assert.equal(description.ok, true); assert(!JSON.stringify(description).includes('SECRET')); assert.equal(released, 1);
  ctx.SpreadsheetApp = { openById: () => ({ getSheetByName: () => null }) };
  assert.deepEqual(plain(ctx.describeAiCost().tabs['AI費用サマリ'].headers), []);
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => false }) };
  assert.deepEqual(plain(ctx.describeAiCost()), { ok: false, status: 503, error: 'busy' });
});
test('routing and command registration only add the new handlers', () => {
  for (const kind of ['ai-cost-summary','ai-cost-pending','ai-cost-describe']) assert(source('WebApp.gs').includes(`'${kind}':`));
  assert.match(source('CommandQueue.gs'), /describeAiCost:\s*describeAiCost/);
  vm.runInContext(source('LedgerUnifyLogic.gs'), ctx);
  const rows = ctx.buildIndexRows(['AI費用サマリ', 'freee登録待ち', 'PC稼働状況'], 'id', '', 'id');
  assert(rows.some((r) => r[0] === 'AI費用サマリ' && r[1] === '年月×サービス'));
  assert(rows.some((r) => r[0] === 'PC稼働状況' && r[1] === '1PC'));
});
test('GAS writes into existing book, preserves accounting entries across shifted rows, releases lock on failure', () => {
  const gas = vm.createContext({});
  for (const file of ['UpsertLogic.gs','AiCost.gs','AiCostLogic.gs','CloudLedger.gs','CloudLedgerLogic.gs']) vm.runInContext(source(file), gas);
  const book = new Map(), calls = [];
  const makeSheet = () => {
    const values = [];
    return { values, getLastRow: () => values.length, getLastColumn: () => values[0]?.length || 0,
      deleteRow: (r) => values.splice(r - 1, 1),
      getRange: (r, c, nr = 1, nc = 1) => ({
        getDisplayValues: () => values.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc).map(String)),
        getValues: () => values.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        setValue: (v) => { calls.push(['cell', r, c]); values[r - 1][c - 1] = v; },
        setValues: (rows) => rows.forEach((row, offset) => { values[r - 1 + offset] ||= []; row.forEach((v, col) => { values[r - 1 + offset][c - 1 + col] = v; }); }),
      }),
    };
  };
  let releases = 0;
  gas.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'existing' }) };
  gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => releases++ }) };
  gas.SpreadsheetApp = { openById: (id) => { assert.equal(id, 'existing'); return { getSheetByName: (name) => book.get(name), insertSheet: (name) => { const sheet = makeSheet(); book.set(name, sheet); return sheet; } }; } };
  assert.equal(gas.upsertAiCostSummary({ rows: [{ ...item, updatedAt: 'now' }] }).appended, 1);
  assert.equal(gas.replaceAiCostPending({ months: [item.month], rows: [item] }).appended, 1);
  const sheet = book.get('freee登録待ち');
  sheet.values.push(row(pending, { 年月: item.month, サービス: 'protected', 登録済み: '済', 勘定科目: '人', 税区分: '人', 検出日: 'old' }));
  assert.equal(gas.replaceAiCostPending({ months: [item.month], rows: [{ ...item, service: 'protected' }] }).deleted, 1);
  assert.equal(sheet.values.length, 2);
  assert.equal(sheet.values[1][pending.indexOf('登録済み')], '済');
  assert.equal(sheet.values[1][pending.indexOf('勘定科目')], '人');
  assert.equal(sheet.values[1][pending.indexOf('税区分')], '人');
  assert.equal(sheet.values[1][pending.indexOf('検出日')], item.detectedAt);
  assert(calls.every(([, , c]) => !['登録済み','勘定科目','税区分'].includes(pending[c - 1])));
  assert.throws(() => gas.replaceAiCostPending({ months: [item.month], rows: [item, item] }), /duplicate/);
  assert.equal(releases, 4);
});
