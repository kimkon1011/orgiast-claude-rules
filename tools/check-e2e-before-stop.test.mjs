import test from 'node:test';
import assert from 'node:assert/strict';
import { checkE2eBeforeStop } from './check-e2e-before-stop.mjs';

test('完了報告だけならwarnする', () => {
  const result = checkE2eBeforeStop('実装完了しました');
  assert.equal(result.decision, 'warn');
  assert.match(result.message, /ONBOARDING §1\.4\.4/);
});

test('Layer 2 e2e passedの記載があればpassする', () => {
  assert.deepEqual(checkE2eBeforeStop('実装完了、Layer 2 e2e 3 passed'), { decision: 'pass' });
});
