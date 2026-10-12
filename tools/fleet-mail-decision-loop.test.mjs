import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDecisionRequest, decisionRole } from './fleet-mail.mjs';

test('decisionRole distinguishes requests, answers and ordinary messages', () => {
  for (const field of ['body', 'why']) {
    const tagged = { id: 'mail-original', [field]: ' \n[判断依頼] 承認' };
    assert.equal(decisionRole(tagged), 'request');
    assert.equal(decisionRole({ ...tagged, replyTo: 'mail-1' }), 'answer');
    assert.equal(decisionRole({ ...tagged, id: 'mail-reply-abc' }), 'answer');
  }
  for (const mail of [
    {}, { body: '通常', why: '確認' }, { body: '本文中の [判断依頼]' },
    { id: 'mail-reply-abc', body: '通常の返信' },
    { replyTo: 'mail-1', why: '通常の返信' },
  ]) assert.equal(decisionRole(mail), null);
});

test('原本の判断依頼は判断依頼として扱う', () => {
  assert.equal(hasDecisionRequest({ id: 'mail-20261010-1', why: '[判断依頼] 制作アプリ', body: 'x' }), true);
});
test('受領返信は why を引き継いでも判断依頼として扱わない（PC 間ループ防止）', () => {
  assert.equal(hasDecisionRequest({ id: 'mail-reply-abc', replyTo: 'mail-20261010-1', why: '[判断依頼] 制作アプリ', body: '受領しました' }), false);
  assert.equal(hasDecisionRequest({ id: 'mail-reply-abc', why: '[判断依頼] 制作アプリ', body: '受領しました' }), false);
  assert.equal(hasDecisionRequest({ id: 'mail-x', replyTo: 'mail-1', why: '[判断依頼] y', body: 'z' }), false);
});
