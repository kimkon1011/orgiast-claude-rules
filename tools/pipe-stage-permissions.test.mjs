import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesAllowed, splitStages } from './pipe-stage-permissions.mjs';

test('クォート内のパイプを分割しない', () => {
  assert.deepEqual(splitStages('grep -E "foo|bar" file | wc -l'), ['grep -E "foo|bar" file ', ' wc -l']);
});

test('危険なenv代入は許可しない', () => {
  assert.equal(matchesAllowed('PATH=/x ls', new Set(['ls'])), false);
});

test('複数ステージがそれぞれ許可プレフィックスに一致する', () => {
  const allowed = new Set(['git status', 'git log']);
  assert.equal(splitStages('git status && git log').every(stage => matchesAllowed(stage.trim(), allowed)), true);
});
