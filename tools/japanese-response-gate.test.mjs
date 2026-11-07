import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, measure } from './japanese-response-gate.mjs';

test('英語だけの応答は止める', () => {
  const text = 'The role change is done and live. I confirmed the deployment points to version 66 and the staff screen now shows three roles. Next I will verify the live page again.';
  const result = judge(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'JAPANESE-ONLY');
});

test('日本語の役割名が混じっていても本文が英語なら止める（10/18 の実例）', () => {
  const text = 'The screen now has 3 roles: **プロデューサー/ディレクター, ドライバー, 設営スタッフ**. It is live on the screen staff use, so W2 setup tomorrow will run on the new layout. Old links still work and the report button moved to the bottom left.';
  assert.equal(judge(text).decision, 'block');
});

test('英単語・コード・URL・パスが多い日本語の応答は通す', () => {
  const text = [
    '本番 HEAD に反映しました（PR #39 をマージ、read-back 一致）。',
    '```bash\nnode tools/gas-overlay-push.mjs --project . --files "Checklist.js,ui/Checklist.html" --dry-run\n```',
    '確認先: [当日チェックリスト](https://script.google.com/macros/s/AKfycbw029LMCGep8CBGDRg1EOb_gsI81zeGqCmq8umPsRQkwYP1MSae7pSDkLJ6vBpKNq87/exec?app=checklist)',
    'C:/Users/kimko/wt-booth-roles/src/Checklist.js の `Checklist_normalizeRole` で旧役割名を読み替えます。',
  ].join('\n');
  assert.equal(judge(text).decision, 'pass');
});

test('短い英語（コマンド結果の一言など）は止めない', () => {
  assert.equal(judge('OK. Deployed @66.').decision, 'pass');
});

test('user が英語を明示した場合は [EN-OK] で通す', () => {
  const text = '[EN-OK] Here is the English summary you asked for. The checklist now reads the construction slides and links each step to its page, so staff can open the right slide directly.';
  assert.equal(judge(text).decision, 'pass');
});

test('空の応答は通す', () => {
  assert.equal(judge('').decision, 'pass');
});

test('measure はコードブロック内の英字を数えない', () => {
  const { latin } = measure('説明です。\n```\nconst veryLongIdentifierName = somethingElseEntirely();\n```');
  assert.equal(latin, 0);
});
