import test from 'node:test';
import assert from 'node:assert/strict';
import { effortSavings, main } from './effort-cost-model.mjs';

const approx = (actual, expected, tolerance = 0.1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} ≈ ${expected} (±${tolerance})`);

test('X-0021 固定ケース: p=0.97, L=$0.17, H=$0.29, n=100 → 約38.4%減（35%以上）', () => {
  const r = effortSavings({ taskCount: 100, passRate: 0.97, lowCostPerTask: 0.17, highCostPerTask: 0.29 });
  approx(r.allHighCost, 29.0);
  approx(r.lowFirstCost, 17.87);
  approx(r.savingsPct, 38.4);
  assert.ok(r.savingsPct >= 35, `savingsPct ${r.savingsPct} が 35% 以上であること`);
  assert.equal(typeof r.explanationJp, 'string');
  assert.ok(r.explanationJp.includes('38.4'), '説明文に計算結果を含む');
});

test('p=1.0（全タスク low で通る）→ 約41.4%減', () => {
  const r = effortSavings({ taskCount: 100, passRate: 1.0, lowCostPerTask: 0.17, highCostPerTask: 0.29 });
  approx(r.savingsPct, 41.4);
});

test('p=0.5（正解率が低い）→ コスト増（削減率マイナス）', () => {
  const r = effortSavings({ taskCount: 100, passRate: 0.5, lowCostPerTask: 0.17, highCostPerTask: 0.29 });
  assert.ok(r.savingsPct < 0, `savingsPct=${r.savingsPct} は 0 未満（コスト増）`);
  assert.ok(r.lowFirstCost > r.allHighCost);
});

test('バリデーション: passRate > 1 は throw', () => {
  assert.throws(() => effortSavings({ taskCount: 100, passRate: 1.01, lowCostPerTask: 0.17, highCostPerTask: 0.29 }));
});

test('バリデーション: passRate < 0 は throw', () => {
  assert.throws(() => effortSavings({ taskCount: 100, passRate: -0.1, lowCostPerTask: 0.17, highCostPerTask: 0.29 }));
});

test('バリデーション: taskCount = 0 は throw', () => {
  assert.throws(() => effortSavings({ taskCount: 0, passRate: 0.97, lowCostPerTask: 0.17, highCostPerTask: 0.29 }));
});

test('バリデーション: taskCount が非整数は throw', () => {
  assert.throws(() => effortSavings({ taskCount: 2.5, passRate: 0.97, lowCostPerTask: 0.17, highCostPerTask: 0.29 }));
});

test('CLI デフォルト引数: 0.97 / 0.17 / 0.29 / 100 の結果を返す', () => {
  const r = main(['node', 'tools/effort-cost-model.mjs']);
  assert.equal(r.passRate, 0.97);
  assert.equal(r.lowCostPerTask, 0.17);
  assert.equal(r.highCostPerTask, 0.29);
  assert.equal(r.taskCount, 100);
  approx(r.savingsPct, 38.4);
  assert.equal(typeof r.explanationJp, 'string');
});