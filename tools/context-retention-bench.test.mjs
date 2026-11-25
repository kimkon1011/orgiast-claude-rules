// context-retention-bench.mjs の純関数のみをテストする（ネットワーク不要）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, KINDS, buildSummaryPrompt, buildStructuredPrompt, extractJson, normalizeFact, renderStructured, scoreRetention, validateFacts } from './context-retention-bench.mjs';

const sample = Object.fromEntries(KINDS.map((kind) => [kind, [{ key: kind, value: kind + '-value' }]]));

test('extractJson: コードフェンス付きJSONを読む', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson: 前置き混入に耐える', () => {
  assert.deepEqual(extractJson('結果です。\n{"a":1}\n以上です。'), { a: 1 });
});

test('extractJson: JSONなしは null', () => {
  assert.equal(extractJson('結果はありません'), null);
});

test('renderStructured: gold の全値を含む（無損失）', () => {
  for (const c of CASES) {
    const obj = Object.fromEntries(KINDS.map((kind) => [kind, c.gold.filter((x) => x.kind === kind).map(({ key, value }) => ({ key, value }))]));
    const text = renderStructured(obj);
    for (const fact of c.gold) assert.ok(text.includes(fact.value), c.id + ': ' + fact.value);
  }
});

test('renderStructured: null入力は空文字', () => {
  assert.equal(renderStructured(null), '');
});

test('renderStructured: 空オブジェクトは例外を投げない', () => {
  assert.doesNotThrow(() => renderStructured({}));
  assert.equal(renderStructured({}), '');
});

test('normalizeFact: 全角数字を半角化する', () => {
  assert.equal(normalizeFact('number', '１２３件'), '123件');
});

test('normalizeFact: SHAを小文字化する', () => {
  assert.equal(normalizeFact('ref', 'A1B2C3D'), 'a1b2c3d');
});

test('normalizeFact: 空白を正規化する', () => {
  assert.equal(normalizeFact('decision', '  base　は   main  '), 'base は main');
});

test('scoreRetention: 完全一致で満点', () => {
  const gold = [{ kind: 'ref', key: 'pr', value: 'PR #271' }, { kind: 'path', key: 'file', value: 'src/example/a.js' }];
  const r = scoreRetention(gold, 'PR #271 と src/example/a.js');
  assert.equal(r.matched, 2); assert.equal(r.recall, 1);
});

test('scoreRetention: 番号欠落では ref が0点', () => {
  const r = scoreRetention([{ kind: 'ref', key: 'pr', value: 'PR #271' }], 'PRをマージした');
  assert.equal(r.matched, 0); assert.equal(r.byKind.ref.recall, 0);
});

test('scoreRetention: 部分一致は加点しない', () => {
  const r = scoreRetention([{ kind: 'ref', key: 'task', value: 'TASK-314' }], 'TASK-3140 を確認');
  assert.equal(r.matched, 0);
});

test('scoreRetention: byKind の内訳が正しい', () => {
  const gold = [{ kind: 'ref', key: 'task', value: 'TASK-314' }, { kind: 'path', key: 'file', value: 'src/example/a.js' }];
  const r = scoreRetention(gold, 'TASK-314 のみ');
  assert.deepEqual(r.byKind.ref, { matched: 1, total: 1, recall: 1 });
  assert.deepEqual(r.byKind.path, { matched: 0, total: 1, recall: 0 });
  assert.equal(r.missing[0].value, 'src/example/a.js');
});

test('validateFacts: 正しいスキーマは true', () => {
  assert.equal(validateFacts(sample), true);
});

test('validateFacts: キー欠落は false', () => {
  const broken = { ...sample }; delete broken.open;
  assert.equal(validateFacts(broken), false);
});

test('prompt: 記録と方式固有の指示を含む', () => {
  assert.ok(buildSummaryPrompt(CASES[0]).includes('500字以内'));
  assert.ok(buildStructuredPrompt(CASES[0]).includes(CASES[0].transcript));
  for (const kind of KINDS) assert.ok(buildStructuredPrompt(CASES[0]).includes(kind));
});

test('CASES: 全 gold value が対応する transcript に実在する', () => {
  assert.equal(CASES.length, 5);
  for (const c of CASES) for (const fact of c.gold) assert.ok(c.transcript.includes(fact.value), c.id + ': ' + fact.value);
});
