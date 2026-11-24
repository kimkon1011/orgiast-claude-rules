import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBoothCc } from './booth-sales-cc.mjs';

test('ブース件名の社外メールへ佐藤さんを追加する', () => {
  const result = applyBoothCc({ to: 'customer@example.com', subject: '展示会ブースのご提案' });
  assert.deepEqual(result.cc, ['satou@orgiast.jp']);
  assert.equal(result.added, true);
  assert.equal(result.reason, 'keyword:ブース');
});

test('既にCC済みなら大文字小文字を問わず重複しない', () => {
  const result = applyBoothCc({ to: 'customer@example.com', cc: 'Satou@Orgiast.jp', body: '出展について' });
  assert.deepEqual(result.cc, ['Satou@Orgiast.jp']);
  assert.equal(result.added, false);
});

test('社内宛のみならブースメールでも追加しない', () => {
  const result = applyBoothCc({ to: ['staff@orgiast.jp'], subject: '展示会ブース' });
  assert.deepEqual(result.cc, []);
  assert.equal(result.reason, 'internal_only');
});

test('非ブースメールなら社外宛でも追加しない', () => {
  const result = applyBoothCc({ to: 'customer@example.com', subject: '請求書のご案内' });
  assert.deepEqual(result.cc, []);
  assert.equal(result.reason, 'not_booth_sales');
});

test('--booth 相当の明示指定ならキーワードなしでも追加する', () => {
  const result = applyBoothCc({ to: 'customer@example.com', subject: 'ご提案', booth: true });
  assert.deepEqual(result.cc, ['satou@orgiast.jp']);
  assert.equal(result.reason, 'explicit_booth_flag');
});
