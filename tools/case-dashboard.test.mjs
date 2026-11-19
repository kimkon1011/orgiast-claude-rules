import test from 'node:test';
import assert from 'node:assert/strict';
import { inferType, choiceValues, matchColumn, serialToDate, buildSchema, generateHtml } from './case-dashboard.mjs';

test('inferType date', () => {
  assert.equal(inferType(['2024-01-15', '2024-02-20', '2024/03/10', '']), 'date');
});

test('inferType serial date with matching column name', () => {
  // 列名に「日」を含み、値が 20000〜80000 の数値 → date
  assert.equal(inferType([45980, 45981, 46000, null], '発行日'), 'date');
});

test('inferType serial date with non-matching column name', () => {
  // 列名に「日」「日付」「date」を含まなければ number のまま
  assert.equal(inferType([45980, 45981, 46000, null], '売上'), 'number');
});

test('inferType serial date without column name', () => {
  // columnName が空でも数値は number（元の動作）
  assert.equal(inferType([45980, 45981, 46000, null]), 'number');
});

test('inferType number', () => {
  assert.equal(inferType(['1000', '25000', '500000', '99', '']), 'number');
});

test('inferType choice - 12以下のユニーク値かつ30%未満', () => {
  const vals = ['確定','進行中','確定','完了','進行中','完了','確定','完了','確定','進行中','確定'];
  assert.equal(inferType(vals), 'choice');
});

test('inferType string (default)', () => {
  assert.equal(inferType(['株式会社A', '有限会社B', '合同会社C']), 'string');
});

test('inferType empty', () => {
  assert.equal(inferType([]), 'string');
});

test('choiceValues dedup and sort', () => {
  assert.deepEqual(choiceValues(['b', 'a', 'b', '', 'c', 'a', null]), ['a', 'b', 'c']);
});

test('choiceValues all empty', () => {
  assert.deepEqual(choiceValues(['', null, undefined]), []);
});

test('matchColumn 部分一致', () => {
  assert.equal(matchColumn('状態', ['状態', 'フェーズ']), true);
});

test('matchColumn 全角スペース除去', () => {
  assert.equal(matchColumn('担　当', ['担当者', '担当']), true);
});

test('matchColumn case insensitive', () => {
  assert.equal(matchColumn('Phase', ['状態', 'フェーズ', 'phase']), true);
});

test('matchColumn 不一致', () => {
  assert.equal(matchColumn('案件名', ['状態', 'フェーズ']), false);
});

test('serialToDate converts 45980 to 2025-11-19', () => {
  assert.equal(serialToDate(45980), '2025-11-19');
});

test('serialToDate range edges', () => {
  assert.equal(serialToDate(20000), '1954-10-03');
  assert.equal(serialToDate(80000), '2119-01-11');
});

test('serialToDate non-serial returns string', () => {
  assert.equal(serialToDate('abc'), 'abc');
  assert.equal(serialToDate(100), '100');
});

test('buildSchema adds skipped for empty and #REF! headers', () => {
  const schema = buildSchema(
    ['案件ID', '', '案件名', '#REF!error'],
    ['string', 'string', 'string', 'string'],
    {}
  );
  assert.equal(schema[0].skipped, undefined, '正常な列は skipped なし');
  assert.equal(schema[1].skipped, true, '空見出しは skipped');
  assert.equal(schema[3].skipped, true, '#REF! 見出しは skipped');
  assert.equal(schema[3].name, '#REF!error');
});

test('buildSchema shows distinct count not choices array', () => {
  const schema = buildSchema(
    ['状態', '名前'],
    ['choice', 'string'],
    { 0: ['確定', '進行中', '完了'] }
  );
  assert.deepEqual(schema[0].distinct, 3, 'ユニーク値の数');
  assert.equal(schema[0].choices, undefined, 'choices 配列は出力しない');
  assert.equal(schema[1].distinct, undefined, 'choice 以外は distinct なし');
});

test('generateHtml escapes <script>', () => {
  const html = generateHtml({
    headers: ['案件名', 'メモ'],
    types: ['string', 'string'],
    choiceMap: {},
    rows: [
      ['<script>alert("xss")</script>', '正常なメモ'],
    ],
  });
  assert.ok(!html.includes('<script>alert'), '<script> がエスケープされていない');
  assert.ok(html.includes('正常なメモ'), '正常なテキストが保持されていない');
});

test('generateHtml empty rows', () => {
  const html = generateHtml({
    headers: ['ID', 'Name'],
    types: ['string', 'string'],
    choiceMap: {},
    rows: [],
  });
  assert.ok(html.includes('全件一覧'));
});

test('generateHtml no status column', () => {
  const html = generateHtml({
    headers: ['ID', 'Name'],
    types: ['string', 'string'],
    choiceMap: {},
    rows: [['C001', 'Test']],
  });
  assert.ok(html.includes('C001'));
  assert.ok(html.includes('Test'));
});

test('generateHtml with status column', () => {
  const html = generateHtml({
    headers: ['ID', '状態', 'Name'],
    types: ['string', 'choice', 'string'],
    choiceMap: { 1: ['確定', '進行中'] },
    rows: [['C001', '確定', 'A'], ['C002', '進行中', 'B']],
  });
  assert.ok(html.includes('状態別件数'));
});

test('generateHtml skips #REF! and empty header columns', () => {
  const html = generateHtml({
    headers: ['案件ID', '', '案件名', '#REF!'],
    types: ['string', 'string', 'string', 'string'],
    choiceMap: {},
    rows: [['C001', 'irrelevant', 'テスト案件', 'N/A'], ['C002', '', '案件B', '']],
  });
  assert.ok(html.includes('案件ID'), '正常な列見出しは表示');
  assert.ok(html.includes('案件名'), '正常な列見出しは表示');
  assert.ok(!html.includes('irrelevant'), 'スキップ列の行データは非表示');
  assert.ok(!html.includes('#REF!'), '#REF! 見出しは非表示');
  // 空見出し列はテーブルに表示されない（見出しが空文字なので）
});

test('generateHtml converts date serial values', () => {
  const html = generateHtml({
    headers: ['案件ID', '発行日'],
    types: ['string', 'date'],
    choiceMap: {},
    rows: [['C001', 45980], ['C002', 45981]],
  });
  assert.ok(html.includes('2025-11-19'), 'シリアル値 45980 → 2025-11-19');
  assert.ok(html.includes('2025-11-20'), 'シリアル値 45981 → 2025-11-20');
});