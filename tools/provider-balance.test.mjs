import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBalance, fetchProviderBalance } from './provider-balance.mjs';

test('confirmed provider response shapes are parsed', async () => {
  const cases = [
    ['deepseek', { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] }, 12.34],
    ['openrouter', { data: { total_credits: 20, total_usage: 3.25 } }, 16.75],
    ['kimi', { data: { available_balance: 9.5 } }, 9.5],
  ];
  for (const [provider, body, expected] of cases) assert.equal((await fetchProviderBalance({ provider, key: 'secret', url: 'https://example.test', fetchImpl: async () => new Response(JSON.stringify(body)) })).balanceUsd, expected);
});
test('401 and network failures remain unmeasurable, never zero', async () => {
  const denied = await fetchProviderBalance({ provider: 'deepseek', key: 'secret', url: 'x', fetchImpl: async () => new Response('', { status: 401 }) });
  assert.equal(denied.balanceUsd, null); assert.match(denied.reason, /401/);
  const offline = await fetchProviderBalance({ provider: 'deepseek', key: 'secret', url: 'x', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.balanceUsd, null); assert.match(offline.reason, /offline/);
});
test('anomaly and low thresholds are strict at specified boundaries', () => {
  assert.equal(classifyBalance({ todaySpendUsd: 1, avg7dSpendUsd: 0.49, balanceUsd: 9, autoTopUp: false }), 'anomaly');
  assert.equal(classifyBalance({ todaySpendUsd: 1, avg7dSpendUsd: 0.5, balanceUsd: 9, autoTopUp: false }), 'ok');
  assert.equal(classifyBalance({ todaySpendUsd: 0.99, avg7dSpendUsd: 0, balanceUsd: 9, autoTopUp: false }), 'ok');
  assert.equal(classifyBalance({ todaySpendUsd: 0, avg7dSpendUsd: 0, balanceUsd: 2.99, autoTopUp: false }), 'low');
  assert.equal(classifyBalance({ todaySpendUsd: 0, avg7dSpendUsd: 0, balanceUsd: 2.99, autoTopUp: true }), 'ok');
});
