import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDecisionRequest } from './fleet-mail.mjs';

test('原本の判断依頼は判断依頼として扱う', () => {
  assert.equal(hasDecisionRequest({ id: 'mail-20261010-1', why: '[判断依頼] 制作アプリ', body: 'x' }), true);
});
test('受領返信は why を引き継いでも判断依頼として扱わない（PC 間ループ防止）', () => {
  assert.equal(hasDecisionRequest({ id: 'mail-reply-abc', replyTo: 'mail-20261010-1', why: '[判断依頼] 制作アプリ', body: '受領しました' }), false);
  assert.equal(hasDecisionRequest({ id: 'mail-reply-abc', why: '[判断依頼] 制作アプリ', body: '受領しました' }), false);
  assert.equal(hasDecisionRequest({ id: 'mail-x', replyTo: 'mail-1', why: '[判断依頼] y', body: 'z' }), false);
});
