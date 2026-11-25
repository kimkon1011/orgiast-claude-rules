import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateStaffResult, calculateStatistics, gradeFor } from '../eval-engine.mjs';
import { importScoreTable, parseDelimited, resolveColumn } from '../sheet-import.mjs';
import { parse } from '../nl-input.mjs';
import { createStore, STORAGE_KEY } from '../store.mjs';

test('重み付きスコアを正規化して算出する', () => {
  const result = calculateStaffResult(
    { id: 's1', name: '佐藤' },
    [{ id: 'quality', name: '品質', weight: 3 }, { id: 'speed', name: '速度', weight: 1 }],
    [{ staffId: 's1', criterionId: 'quality', score: 5 }, { staffId: 's1', criterionId: 'speed', score: 1 }],
  );
  assert.equal(result.score, 4);
  assert.equal(result.grade, 'A');
});

test('等級の既定閾値は境界値を含み、設定で変更できる', () => {
  assert.deepEqual([4.5, 3.5, 2.5, 1.5, 1.49].map((score) => gradeFor(score)), ['S', 'A', 'B', 'C', 'D']);
  assert.equal(gradeFor(4, { S: 4, A: 3, B: 2, C: 1 }), 'S');
});

test('統計に基準平均・度数・等級分布・平均降順ランキングが入る', () => {
  const staff = [{ id: 's1', name: '佐藤' }, { id: 's2', name: '田中' }];
  const criteria = [{ id: 'a', name: '積極性', weight: 1 }, { id: 'b', name: '協調性', weight: 1 }];
  const evaluations = [
    { staffId: 's1', criterionId: 'a', score: 5 }, { staffId: 's1', criterionId: 'b', score: 3 },
    { staffId: 's2', criterionId: 'a', score: 3 }, { staffId: 's2', criterionId: 'b', score: 2 },
  ];
  const stats = calculateStatistics(staff, criteria, evaluations);
  assert.equal(stats.criterionStats[0].average, 4);
  assert.equal(stats.criterionStats[0].distribution[5], 1);
  assert.deepEqual(stats.gradeDistribution, { S: 0, A: 1, B: 1, C: 0, D: 0 });
  assert.equal(stats.ranking[0].criterionName, '積極性');
});

test('列は完全一致、空白・改行無視、前方一致の順で解決する', () => {
  assert.deepEqual(resolveColumn(['氏 名', '氏名（説明）'], 'staff'), { status: 'found', index: 0, method: 'exact' });
  assert.deepEqual(resolveColumn(['氏名\n（必須）'], 'staff'), { status: 'found', index: 0, method: 'prefix' });
});

test('完全一致の同名列は警告し先頭を使う', () => {
  const original = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(resolveColumn(['氏名', '氏名'], 'staff').index, 0);
    assert.equal(warnings.length, 1);
  } finally { console.warn = original; }
});

test('列レターはAAまで対応し、未解決はmissingになる', () => {
  const headers = Array.from({ length: 27 }, (_, index) => `列${index}`);
  assert.deepEqual(resolveColumn(headers, 'staff', { columnLetters: { staff: 'AA' } }), { status: 'found', index: 26, method: 'letter' });
  assert.equal(resolveColumn(['部署'], 'staff').status, 'missing');
});

test('TSVとクォート付きCSVをパースする', () => {
  assert.deepEqual(parseDelimited('氏名\t積極性\n佐藤\t5'), [['氏名', '積極性'], ['佐藤', '5']]);
  assert.deepEqual(parseDelimited('氏名,備考\n佐藤,"良い, とても"'), [['氏名', '備考'], ['佐藤', '良い, とても']]);
});

test('スコア表で数値でないセルは例外にせずskippedへ入れる', () => {
  const result = importScoreTable('氏名\t積極性（1〜5）\n佐藤\t5\n田中\t未評価', {
    criteria: [{ id: 'active', name: '積極性', weight: 1 }],
  });
  assert.deepEqual(result.entries, [{ staffName: '佐藤', criterionId: 'active', criterionName: '積極性', score: 5 }]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].value, '未評価');
});

test('話し言葉の単一・複数評価を解析する', async () => {
  const result = await parse('佐藤さん コミュニケーション 5\n田中: 積極性3, チームワーク 4');
  assert.deepEqual(result.entries, [
    { staffName: '佐藤', criterionName: 'コミュニケーション', score: 5 },
    { staffName: '田中', criterionName: '積極性', score: 3 },
    { staffName: '田中', criterionName: 'チームワーク', score: 4 },
  ]);
  assert.deepEqual(result.errors, []);
});

test('曖昧な自然言語行は原文付きerrorsへ入れる', async () => {
  const result = await parse('佐藤さんはとても良かった');
  assert.equal(result.entries.length, 0);
  assert.equal(result.errors[0].line, '佐藤さんはとても良かった');
});

test('AIアダプタがあればその結果を使う', async () => {
  const expected = { entries: [{ staffName: '佐藤', criterionName: '品質', score: 5 }], errors: [] };
  assert.deepEqual(await parse('自由文', { aiAdapter: async () => expected }), expected);
});

test('storeは差し替え可能なメモリ実装で保存・読込・削除できる', () => {
  const memory = new Map();
  const storage = { getItem: (key) => memory.has(key) ? memory.get(key) : null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  const store = createStore(storage);
  assert.equal(store.load('初期値'), '初期値');
  store.save({ staff: [] });
  assert.deepEqual(JSON.parse(memory.get(STORAGE_KEY)), { staff: [] });
  assert.deepEqual(store.load(), { staff: [] });
  store.clear();
  assert.equal(store.load(null), null);
});
