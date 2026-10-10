import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeJapaneseReply } from './japanese-reply-gate.mjs';

test('英語主体の応答は block', () => {
  const t = 'The change is finished, live in the production sheet and committed. The print-checklist tests pass, 59 of 59. Nothing was pushed to the remote. Every item in each case is now pulled in.';
  assert.equal(judgeJapaneseReply(t).decision, 'block');
});
test('日本語主体（英語の関数名・URL・コードを含む）は pass', () => {
  const t = '実装が完了し、本番シートに反映してコミットしました。`PrintChecklist_build` のテストは59件すべて成功です。[印刷物チェックシート](https://docs.google.com/a/orgiast.jp/spreadsheets/d/x/edit) を kim@orgiast.jp で開いてください。\n```\ngit log --oneline -1 feat print checklist something long english words here\n```';
  assert.equal(judgeJapaneseReply(t).decision, 'pass');
});
test('短い英語は対象外', () => {
  assert.equal(judgeJapaneseReply('Done. Tests pass.').decision, 'pass');
});
