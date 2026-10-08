import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskKind, CODEX_KINDS } from './task-kind.mjs';

export const CASES = [
  ['codex-do.mjs に --budget オプションを実装して', 'implement'],
  ['この関数のバグを修正して commit する', 'implement'],
  ['原因を調査して修正し、PR を作る', 'implement'],
  ['Add a feature flag and push the branch', 'implement'],
  ['テストを書いて直す', 'implement'],
  ['node --test を実行して結果を報告して', 'verify'],
  ['本番で再現するか動作確認して', 'verify'],
  ['Run the tests and verify the build passes', 'verify'],
  ['cron が止まっている原因を調査してレポートにまとめて', 'investigate'],
  ['A案とB案を比較して確認する', 'investigate'],
  ['次の処理は要検証。ログを読み取りだけで確認(読み取り)', 'investigate'],
  ['Investigate why the nightly job fails and report', 'investigate'],
  ['この問い合わせを緊急/通常に分類して', 'classify'],
  ['Classify each email into one of the labels', 'classify'],
  ['この議事録を3行で要約して', 'summarize'],
  ['Summarize the following notes', 'summarize'],
  ['調査レポートを作成して', 'investigate'],
  ['あれをよろしく', 'implement'],
  ['', 'implement'],
];

for (const [text, expected] of CASES) {
  test(`分類: ${text || '(空)'} -> ${expected}`, () => {
    assert.equal(classifyTaskKind(text), expected);
  });
}

test('15 ケース以上ある', () => assert.ok(CASES.length >= 15));
test('Codex を使うのは implement と verify だけ', () => {
  assert.deepEqual([...CODEX_KINDS].sort(), ['implement', 'verify']);
});
test('null / undefined でも落ちず implement', () => {
  assert.equal(classifyTaskKind(null), 'implement');
  assert.equal(classifyTaskKind(undefined), 'implement');
});
