import test from 'node:test';
import assert from 'node:assert/strict';

import { chainBackendBudgetSecs, effectiveBackendTimeoutSecs, shouldAdvanceToNextBackend } from './codex-do.mjs';
import { deprioritizeRecentFailures } from './fallback-backend-health.mjs';

test('各バックエンドの予算は連鎖全体の残り予算以下にクリップされる', () => {
  assert.equal(chainBackendBudgetSecs(300, 275, {}, { backendName: 'deepseek', kind: 'implement' }), 25);
  assert.equal(effectiveBackendTimeoutSecs('deepseek', { chainBudget: 25, kind: 'implement', env: {} }), 25);
});

test('N個のバックエンドでも合計待ち時間は全体予算を超えない', () => {
  let elapsed = 0;
  for (const name of ['deepseek', 'gemini-cli', 'deepseek', 'gemini-cli']) {
    const budget = chainBackendBudgetSecs(300, elapsed, {}, { backendName: name, kind: 'implement' });
    elapsed += effectiveBackendTimeoutSecs(name, { chainBudget: budget, kind: 'implement', env: {} });
  }
  assert.equal(elapsed, 300);
  assert.equal(chainBackendBudgetSecs(300, elapsed, {}), 0);
});

test('直近失敗したバックエンドは次回順序の先頭に来ない', () => {
  const now = 10_000;
  const backends = [{ name: 'deepseek' }, { name: 'gemini-cli' }, { name: 'openrouter-code' }];
  const history = [{ t: now - 1, backend: 'deepseek', outcome: 'timeout' }];
  assert.deepEqual(deprioritizeRecentFailures(backends, history, { now }).map((item) => item.name),
    ['gemini-cli', 'openrouter-code', 'deepseek']);
});

test('1本目が成功する正常系は次候補へ進まない', () => {
  assert.deepEqual(shouldAdvanceToNextBackend({ status: 0 }), { advance: false, outcome: 'ok' });
});
