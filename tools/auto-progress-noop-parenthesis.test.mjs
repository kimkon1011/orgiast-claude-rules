import test from 'node:test';
import assert from 'node:assert/strict';
import { isNoopPromise } from './auto-progress-ledger.mjs';

test('completed promise with sentences inside parentheses is not awaiting approval', () => {
  for (const value of [
    'なし（修正は本番に反映済み。今後の問合せの返信案は新しい照合と計算で作られます）',
    'なし(修正済み。確認済み)',
    'なし',
    'なし（完了済み）',
  ]) assert.equal(isNoopPromise(value), true, value);
  for (const value of [
    '修正を進める（確認後に反映）',
    'なしとは言えない（調査中。修正が必要）',
    '修正を実施します。次に確認します',
  ]) assert.equal(isNoopPromise(value), false, value);
});
