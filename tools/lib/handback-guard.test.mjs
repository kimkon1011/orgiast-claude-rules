import test from 'node:test'; import assert from 'node:assert/strict';
import { assertNoHandback, findHandback, stripHumanOnly } from './handback-guard.mjs';
test('2026-11-26 22:55 の文面を止める', () => {
  const body = '・高橋様が18:00までの勤務が難しい件、承知しました。暮らしのマーケットで仮押さえしていた方の、29日の業務可否の確認をよろしくお願いします。';
  assert.throws(() => assertNoHandback(body, { env: {} }), e => e.code === 'HANDBACK_BLOCKED');
});
test('2026-11-24 の文面を止める', () => {
  assert.throws(() => assertNoHandback('応募者へメールでご確認をお願いします', { env: {} }));
  assert.throws(() => assertNoHandback('まだ届いていなければ大平さんに確認していただけますでしょうか。', { env: {} }));
  assert.throws(() => assertNoHandback('河野様メールへの対応をお願いできますでしょうか。', { env: {} }));
});
test('結果だけ伝える文面は通す', () => {
  assert.deepEqual(findHandback('安井工房さんに11/29の確定を送りました。返事が来たらお知らせします。'), []);
  assert.equal(assertNoHandback('西林様へ送り先確認のメールを送済みです。', { env: {} }).ok, true);
});
test('HUMAN-ONLY タグ付きは通し、タグは外せる', () => {
  const body = '[HUMAN-ONLY: 現地作業] 11/29 9:00に現場で鍵の受け取りをお願いします。';
  assert.equal(assertNoHandback(body, { env: {} }).ok, true);
  assert.equal(stripHumanOnly(body), '11/29 9:00に現場で鍵の受け取りをお願いします。');
});
test('ORGIAST_HANDBACK_GUARD=0 で無効', () => {
  assert.equal(assertNoHandback('確認をお願いします', { env: { ORGIAST_HANDBACK_GUARD: '0' } }).ok, true);
});
