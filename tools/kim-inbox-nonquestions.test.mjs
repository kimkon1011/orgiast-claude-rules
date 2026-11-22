import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonQuestionAsk } from './kim-inbox.mjs';

test('isNonQuestionAsk recognizes notifications that need no reply', () => {
  assert.equal(isNonQuestionAsk('✅ check 達成: 本番反映\n確認済み'), true);
  assert.equal(isNonQuestionAsk('【作業用018】プロジェクト: 配布 ／ セッションの目的: 状態報告 ／ 作業ID: ac64d324'), true);
  assert.equal(isNonQuestionAsk('gate pc=w018 name=deploy verdict=pass remedy=x:available'), true);
});

test('isNonQuestionAsk preserves genuine questions', () => {
  assert.equal(isNonQuestionAsk('【要対応・kim の判断待ち 3日】A案で進めてよいですか'), false);
  assert.equal(isNonQuestionAsk('【早めの対応が必要】送信可否を返答してください'), false);
  assert.equal(isNonQuestionAsk('参考ログには「セッションの目的: 配布 ／ 作業ID: ac64d324」とあります。A/B のどちらかを回答してください'), false);
});

test('isNonQuestionAsk safely rejects empty values', () => {
  for (const value of ['', undefined, '\n\r\n']) assert.equal(isNonQuestionAsk(value), false);
});
