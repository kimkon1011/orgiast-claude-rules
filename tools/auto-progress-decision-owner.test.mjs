import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionOwnerOf, isChoiceFormat } from './auto-progress-decision-owner.mjs';

test('kim markers in nextKim and reason identify kim', () => {
  for (const marker of ['決定ID', 'kim-PC', 'kim の承認', 'kim 承認', 'kim の判断', 'kim ご自身']) {
    for (const field of ['nextKim', 'reason']) assert.equal(decisionOwnerOf({ [field]: marker }), 'kim');
  }
});
test('kim owner takes precedence, other rows belong to the PC owner', () => {
  for (const owner of ['kim@orgiast.jp', 'kim-PC']) assert.equal(decisionOwnerOf({ owner }), 'kim');
  for (const row of [{}, { owner: 'yuna@example.com', nextKim: '設定を開いて保存してください' }, { promise: 'kim の承認を確認' }]) assert.equal(decisionOwnerOf(row), 'owner');
});
test('choice formats are flagged without flagging ordinary actions', () => {
  for (const text of ['A) 続行\nB) 停止', 'Ａ）続行 Ｂ）停止', '1択で指示してください']) assert.equal(isChoiceFormat(text), true);
  for (const text of ['', '設定を保存してください', 'A) この操作を実行']) assert.equal(isChoiceFormat(text), false);
});
