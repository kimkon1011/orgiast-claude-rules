import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutingTable, aggregateMeasurements, ROUTING_CATEGORIES } from './routing-table.mjs';
import { resultRecord } from './eval-harness.mjs';

function task(id, category, status, costUsd = 0.001, ms = 10) {
  return { id, category, status, pass: status === 'pass', costUsd, ms };
}
function rec(provider, model, category, statuses, { costUsd = 0.001, ms = 10, t } = {}) {
  const tasks = statuses.map((status, index) => task(`${provider}-${category}-${index}`, category, status, costUsd, ms));
  return resultRecord(provider, model, tasks, t);
}
const T0 = '2026-08-01T00:00:00Z';
const T1 = '2026-08-02T00:00:00Z';

test('成功率100%の2候補なら最安(同率なら最速)を選ぶ', () => {
  const rows = [
    rec('cheap', 'm1', 'classification', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 100, t: T0 }),
    rec('cheap', 'm1', 'classification', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 100, t: T1 }),
    rec('pricey', 'm2', 'classification', ['pass', 'pass', 'pass'], { costUsd: 0.01, ms: 30, t: T0 }),
    rec('pricey', 'm2', 'classification', ['pass', 'pass', 'pass'], { costUsd: 0.01, ms: 30, t: T1 }),
  ];
  const table = buildRoutingTable(rows);
  const chosen = table.categories.classification;
  assert.equal(chosen.provider, 'cheap');
  assert.equal(chosen.model, 'm1');
  assert.equal(chosen.samples, 2);
  assert.equal(chosen.provisional, undefined);
});

test('同率(同一 usdPerTask)なら最速を選ぶ', () => {
  const rows = [
    rec('slow', 'm1', 'extraction', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 100, t: T0 }),
    rec('slow', 'm1', 'extraction', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 100, t: T1 }),
    rec('fast', 'm2', 'extraction', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 40, t: T0 }),
    rec('fast', 'm2', 'extraction', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 40, t: T1 }),
  ];
  const chosen = buildRoutingTable(rows).categories.extraction;
  assert.equal(chosen.provider, 'fast');
  assert.equal(chosen.model, 'm2');
});

test('成功率 90% 未満の候補しか無いカテゴリは載せない', () => {
  const rows = [
    rec('bad', 'm1', 'summarize', ['pass', 'fail', 'fail'], { costUsd: 0.001, ms: 10, t: T0 }),
    rec('bad', 'm1', 'summarize', ['pass', 'fail', 'fail'], { costUsd: 0.001, ms: 10, t: T1 }),
  ];
  const table = buildRoutingTable(rows);
  assert.equal(table.categories.summarize, undefined);
});

test('計測1回しか無いカテゴリは provisional:true で載る', () => {
  const rows = [rec('only', 'm1', 'jp_reply', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 10, t: T1 })];
  const table = buildRoutingTable(rows);
  const chosen = table.categories.jp_reply;
  assert.equal(chosen.provider, 'only');
  assert.equal(chosen.provisional, true);
  assert.equal(chosen.samples, 1);
});

test('エラー/切断が1割超の計測は成功率の根拠にしない', () => {
  const rows = [
    resultRecord('flaky', 'm1', [
      task('a', 'code', 'error', 0.001, 10), task('b', 'code', 'error', 0.001, 10), task('c', 'code', 'error', 0.001, 10),
    ], T1),
    rec('stable', 'm1', 'code', ['pass', 'pass', 'pass'], { costUsd: 0.002, ms: 10, t: T1 }),
    rec('stable', 'm1', 'code', ['pass', 'pass', 'pass'], { costUsd: 0.002, ms: 10, t: T0 }),
  ];
  const chosen = buildRoutingTable(rows).categories.code;
  assert.equal(chosen.provider, 'stable');
  assert.equal(chosen.samples, 2);
});

test('aggregateMeasurements は直近2回までを集計する', () => {
  const rows = [
    rec('p', 'm', 'code', ['pass', 'pass', 'pass'], { costUsd: 0.001, ms: 10, t: T0 }),
    rec('p', 'm', 'code', ['pass', 'pass', 'pass'], { costUsd: 0.003, ms: 10, t: T1 }),
    rec('p', 'm', 'code', ['pass', 'fail', 'pass'], { costUsd: 0.002, ms: 10, t: '2026-08-03T00:00:00Z' }),
  ];
  const agg = aggregateMeasurements(rows, 'code');
  assert.equal(agg.length, 1);
  assert.equal(agg[0].samples, 2); // 直近2回(3件目と2件目)だけ
  assert.ok(Math.abs(agg[0].rate - 5 / 6) < 0.0001, `rate=${agg[0].rate}`); // pass 3+2 / graded 6
});

test('5カテゴリが表の対象', () => {
  assert.deepEqual(ROUTING_CATEGORIES, ['classification', 'extraction', 'summarize', 'jp_reply', 'code']);
});
