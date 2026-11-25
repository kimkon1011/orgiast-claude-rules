import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKimDm } from './kim-dm-policy.mjs';

for (const text of [
  '【マージのお願い】PR #943 を確認してください',
  'PR #943 をマージしてください',
  'この変更のマージをお願いします',
  'Please merge PR #943',
]) {
  test(`マージ依頼を拒否する: ${text}`, () => {
    assert.deepEqual(classifyKimDm(text), {
      allowed: false,
      category: 'merge-request',
      reason: 'PR のマージ依頼は fleet-mail で扱います',
    });
  });
}

for (const [name, text] of [
  ['警告付きマージ停滞', '⚠️ 自動マージが3日停止中です。確認してください'],
  ['日次レポート', '日次レポート: 本日の売上は10件です'],
  ['支払い依頼', '請求書の支払い操作をお願いします'],
  ['判断依頼', 'A案とB案のどちらにするか判断してください'],
  ['障害通知', '障害: 本番APIが応答していません'],
  ['通常完了報告', 'データ移行が完了しました'],
]) {
  test(`${name}を許可する`, () => assert.equal(classifyKimDm(text).allowed, true));
}


test('recipient identity is shared across IDs, names and owner aliases', async () => {
  const { isKimRecipient, KIM_DISCORD_USER_ID } = await import('./kim-dm-policy.mjs');
  for (const recipient of [{ id: KIM_DISCORD_USER_ID }, { name: ' KIM ' }, { name: '金功勇' }, { owner: 'KIM@ORGIAST.JP' }, { defaultKim: true }]) assert.equal(isKimRecipient(recipient), true);
  for (const recipient of [{ id: 'staff' }, { owner: 'cr@orgiast.jp' }, {}]) assert.equal(isKimRecipient(recipient), false);
});
