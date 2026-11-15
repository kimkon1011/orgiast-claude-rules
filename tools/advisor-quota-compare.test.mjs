import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage, compareConfigs, countAdvisorCalls } from './advisor-quota-compare.mjs';

test('C4 モデル別に全トークン項目を合算する', () => {
  const fixture = `{"type":"assistant","message":{"model":"fiction-sonnet","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":30,"cache_creation_input_tokens":4}}}
{"type":"assistant","message":{"model":"fiction-sonnet","usage":{"input_tokens":5,"output_tokens":3}}}
{"type":"assistant","message":{"model":"fiction-opus","usage":{"output_tokens":1}}}`;
  assert.deepEqual(aggregateUsage(fixture), { byModel: [
    { model: 'fiction-sonnet', input: 15, output: 5, cacheRead: 30, cacheCreate: 4 },
    { model: 'fiction-opus', input: 0, output: 1, cacheRead: 0, cacheCreate: 0 },
  ], missingUsage: 0, badLines: 0 });
});

test('C4 空入力・空行は集計しない', () => {
  for (const fixture of ['', '\r\n  \n']) {
    assert.deepEqual(aggregateUsage(fixture), { byModel: [], missingUsage: 0, badLines: 0 });
  }
});

test('C4 usage 欠損はゼロ、モデル欠損は unknown とし壊れた行を数える', () => {
  const fixture = `{"type":"assistant","message":{}}
{"message":{"role":"assistant","usage":null}}
{"type":"assistant","message":{"usage":{}}}
broken
{"type":"user","message":{"content":"架空の入力"}}`;
  assert.deepEqual(aggregateUsage(fixture), { byModel: [
    { model: 'unknown', input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  ], missingUsage: 2, badLines: 1 });
});

const agg = (input, output = 0, cacheRead = 0, cacheCreate = 0) => ({
  byModel: [{ model: 'fiction', input, output, cacheRead, cacheCreate }],
});

test('C5 既定の仮置き重みですべてのモデルを比較する', () => {
  const baseline = { byModel: [...agg(10, 2, 20, 4).byModel, ...agg(3).byModel] };
  assert.deepEqual(compareConfigs(baseline, agg(15)), { baseline: 30, advisor: 15, reductionRate: 0.5 });
});

test('C5 注入した重みを各項目に適用する', () => {
  assert.deepEqual(compareConfigs(agg(2, 3, 4, 5), agg(1, 1, 1, 1),
    { input: 2, output: 3, cacheRead: 4, cacheCreate: 5 }),
  { baseline: 54, advisor: 14, reductionRate: 40 / 54 });
});

test('C5 空配列とゼロ baseline はゼロ除算せず null を返す', () => {
  const empty = { byModel: [] };
  assert.deepEqual(compareConfigs(empty, empty), { baseline: 0, advisor: 0, reductionRate: null });
  assert.deepEqual(compareConfigs(empty, agg(4)), { baseline: 0, advisor: 4, reductionRate: null });
  assert.deepEqual(compareConfigs(agg(4), empty), { baseline: 4, advisor: 0, reductionRate: 1 });
  assert.equal(compareConfigs(agg(0), agg(4)).reductionRate, null);
});

test('C5 同値はゼロ、advisor 増加時は負の削減率になる', () => {
  assert.equal(compareConfigs(agg(4), agg(4)).reductionRate, 0);
  assert.equal(compareConfigs(agg(4), agg(6)).reductionRate, -0.5);
});

test('C6 未検出・空入力はゼロ回', () => {
  assert.equal(countAdvisorCalls(''), 0);
  assert.equal(countAdvisorCalls('{"message":{"content":[{"type":"tool_use","name":"other"},{"type":"text","text":"advisor"}]}}\nnull\nbroken'), 0);
});

test('C6 複数のマーカーも行単位で数え壊れた行を飛ばす', () => {
  const fixture = `{"message":{"content":[{"type":"tool_use","name":"advisor"},{"type":"text","text":"[ADVISOR] 架空の助言"}]}}
broken
{"message":{"content":[{"type":"text","text":"[ADVISOR] 別の架空助言"}]}}
{"message":{"content":"[ADVISOR] 文字列形式"}}`;
  assert.equal(countAdvisorCalls(fixture), 3);
});

test('C6 detector を注入して独自の行形式を判定できる', () => {
  const seen = [];
  assert.equal(countAdvisorCalls('{"advice":true}\nbroken\n{"advice":false}\n{"advice":true}', (line) => {
    seen.push(line);
    return line.advice === true;
  }), 2);
  assert.equal(seen.length, 3);
});

test('C4 C5 C6 ホールドアウト: 独立した架空混在ログの手計算を照合する', () => {
  // 上の fixture を再利用せず、混在ログ全体の合計と呼び出し数を照合する。
  const holdout = `{"type":"assistant","message":{"model":"fiction-beta","usage":{"input_tokens":8,"cache_read_input_tokens":10},"content":[{"type":"text","text":"[ADVISOR] 架空判断"}]}}
{"type":"assistant","message":{"model":"fiction-alpha"}}
{"type":"assistant","message":{"usage":{"output_tokens":2,"cache_creation_input_tokens":4}}}
{invalid fictional record
{"type":"assistant","message":{"model":"fiction-beta","usage":{"input_tokens":2,"output_tokens":1}}}`;
  const result = aggregateUsage(holdout);
  assert.deepEqual(result, { byModel: [
    { model: 'fiction-beta', input: 10, output: 1, cacheRead: 10, cacheCreate: 0 },
    { model: 'fiction-alpha', input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    { model: 'unknown', input: 0, output: 2, cacheRead: 0, cacheCreate: 4 },
  ], missingUsage: 1, badLines: 1 });
  assert.deepEqual(compareConfigs(agg(62), result), { baseline: 62, advisor: 31, reductionRate: 0.5 });
  assert.equal(countAdvisorCalls(holdout), 1);
});
