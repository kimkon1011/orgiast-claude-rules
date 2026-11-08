import test from 'node:test';
import assert from 'node:assert/strict';
import {
  monthTabName,
  prevMonth,
  monthEndString,
  buildTaskRow,
  findAppendRow,
  decideAction,
} from './furukawa-fee-post.mjs';

// ---------------------------------------------------------------------------
// monthTabName
// ---------------------------------------------------------------------------

test('monthTabName: zero-padding not applied', () => {
  assert.equal(monthTabName(2026, 11), '2026年11月');
  assert.equal(monthTabName(2026, 1), '2026年1月');
  assert.equal(monthTabName(2027, 12), '2027年12月');
});

// ---------------------------------------------------------------------------
// prevMonth
// ---------------------------------------------------------------------------

test('prevMonth: regular month', () => {
  assert.deepEqual(prevMonth(2026, 11), { y: 2026, m: 10 });
  assert.deepEqual(prevMonth(2026, 5), { y: 2026, m: 4 });
});

test('prevMonth: year boundary (January → December of previous year)', () => {
  assert.deepEqual(prevMonth(2026, 1), { y: 2025, m: 12 });
  assert.deepEqual(prevMonth(2027, 1), { y: 2026, m: 12 });
});

// ---------------------------------------------------------------------------
// monthEndString
// ---------------------------------------------------------------------------

test('monthEndString: 30-day month', () => {
  assert.equal(monthEndString(2026, 11), '2026/11/30'); // November has 30 days
  assert.equal(monthEndString(2026, 4), '2026/04/30');
});

test('monthEndString: 31-day month', () => {
  assert.equal(monthEndString(2026, 1), '2026/01/31');
  assert.equal(monthEndString(2026, 12), '2026/12/31');
});

test('monthEndString: February (non-leap year)', () => {
  assert.equal(monthEndString(2027, 2), '2027/02/28');
});

test('monthEndString: February (leap year)', () => {
  assert.equal(monthEndString(2028, 2), '2028/02/29');
});

// ---------------------------------------------------------------------------
// buildTaskRow
// ---------------------------------------------------------------------------

test('buildTaskRow: all fields', () => {
  const row = buildTaskRow({ y: 2026, m: 10, amount: 27000, gid: 123456789 });
  assert.equal(row.A, '金功勇');
  assert.equal(row.B, '学会関連');
  assert.equal(row.C, '業務委託報酬 2026年10月分（古川未歩）');
  assert.equal(row.E, '2026/10/31');
  assert.equal(row.H, '古川未歩');
  assert.equal(row.J, 27000);
  assert.match(row.L, /2026年10月/);
  assert.match(row.M, /gid=123456789/);
  assert.equal(row.U, '✔︎');
});

// ---------------------------------------------------------------------------
// findAppendRow
// ---------------------------------------------------------------------------

test('findAppendRow: empty data returns row 5', () => {
  assert.equal(findAppendRow([]), 5);
  assert.equal(findAppendRow([[null, null, null]]), 5);
});

test('findAppendRow: single data row returns row 6', () => {
  const rows = [['依頼主', 'カテゴリ', '項目']];
  assert.equal(findAppendRow(rows), 6);
});

test('findAppendRow: multiple rows returns next after last', () => {
  const rows = [
    ['A1', 'B1', 'C1'],
    ['A2', 'B2', 'C2'],
    [null, null, null],
  ];
  assert.equal(findAppendRow(rows), 7);
});

test('findAppendRow: trailing null rows ignored', () => {
  const rows = [
    ['A1', 'B1', 'C1'],
    ['A2', 'B2', 'C2'],
    [null, null, null],
    [null, null, null],
  ];
  assert.equal(findAppendRow(rows), 7);
});

test('findAppendRow: row with A empty but B/C filled', () => {
  const rows = [
    ['A1', 'B1', 'C1'],
    ['', 'B2', 'C2'],
  ];
  assert.equal(findAppendRow(rows), 7);
});

// ---------------------------------------------------------------------------
// decideAction
// ---------------------------------------------------------------------------

test('decideAction: matching row found, P empty, J differs → update', () => {
  const rows = [
    [null, null, '業務委託報酬 2026年10月分（古川未歩）', null, null, null, null, '古川未歩', null, 25000],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 27000, posted: null });
  assert.equal(result.type, 'update');
  assert.equal(result.row, 5);
});

test('decideAction: matching row found, P non-empty → none', () => {
  const rows = [
    [null, null, '業務委託報酬 2026年10月分（古川未歩）', null, null, null, null, '古川未歩', null, 25000, null, null, null, null, null, '済'],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 27000, posted: null });
  assert.equal(result.type, 'none');
  assert.equal(result.row, 5);
});

test('decideAction: matching row found, P empty, J same → none', () => {
  const rows = [
    [null, null, '業務委託報酬 2026年10月分（古川未歩）', null, null, null, null, '古川未歩', null, 27000],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 27000, posted: null });
  assert.equal(result.type, 'none');
  assert.equal(result.row, 5);
});

test('decideAction: not found, posted has monthKey → none', () => {
  const rows = [
    [null, null, '別の項目', null, null, null, null, '古川未歩', null, 999],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 27000, posted: { posted: { '2026-10': { row: 12, amount: 27000, at: '2026-11-01T00:00:00.000Z' } } } });
  assert.equal(result.type, 'none');
});

test('decideAction: not found, no posted entry → append', () => {
  const rows = [
    [null, null, '別の項目', null, null, null, null, '古川未歩', null, 999],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 27000, posted: { posted: {} } });
  assert.equal(result.type, 'append');
});

test('decideAction: matching row with different H (different person) → not matched', () => {
  const rows = [
    [null, null, '業務委託報酬 2026年10月分（古川未歩）', null, null, null, null, '別の人', null, 25000],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 27000, posted: { posted: {} } });
  assert.equal(result.type, 'append');
});

// ---------------------------------------------------------------------------
// decideAction with comma-formatted J
// ---------------------------------------------------------------------------

test('decideAction: comma-formatted J matches same amount → none', () => {
  const rows = [
    [null, null, '業務委託報酬 2026年10月分（古川未歩）', null, null, null, null, '古川未歩', null, '27,000'],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 27000, posted: null });
  assert.equal(result.type, 'none');
  assert.equal(result.row, 5);
});

test('decideAction: comma-formatted J with different amount → update', () => {
  const rows = [
    [null, null, '業務委託報酬 2026年10月分（古川未歩）', null, null, null, null, '古川未歩', null, '27,000'],
  ];
  const item = { C: '業務委託報酬 2026年10月分（古川未歩）', H: '古川未歩', y: 2026, m: 10 };
  const result = decideAction({ rows, item, amount: 30000, posted: null });
  assert.equal(result.type, 'update');
  assert.equal(result.row, 5);
});