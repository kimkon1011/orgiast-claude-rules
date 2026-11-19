import test from 'node:test';
import assert from 'node:assert/strict';
import { inferType, choiceValues, matchColumn, generateHtml } from './case-dashboard.mjs';

test('inferType date', () => {
  assert.equal(inferType(['2024-01-15', '2024-02-20', '2024/03/10', '']), 'date');
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