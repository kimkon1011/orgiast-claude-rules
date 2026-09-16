import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBalance, fetchProviderBalance, formatBalanceLine } from './provider-balance.mjs';

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

test('genspark prepaid credits are parsed without a USD parse reason', async () => {
  // REST(実測 2026-09-13)は素の `credit_balance` を返す。`gsk me` の CLI は同じ値を `data` で包む。
  for (const body of [{ credit_balance: 124857.7 }, { status: 'ok', message: 'success', data: { credit_balance: 124857.7 } }]) {
    const result = await fetchProviderBalance({ provider: 'genspark', key: 'secret', url: 'https://example.test', fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.deepEqual(result, { balanceUsd: null, credits: 124857.7 });
    assert.equal('reason' in result, false);
  }

  const missing = await fetchProviderBalance({ provider: 'genspark', key: 'secret', url: 'https://example.test', fetchImpl: async () => new Response(JSON.stringify({ data: {} })) });
  assert.equal(missing.credits, null);
  assert.ok(missing.reason);
});

test('genspark credit threshold and formatting are independent of USD balance', () => {
  assert.equal(classifyBalance({ credits: 4999, balanceUsd: 100, autoTopUp: true }), 'low');
  assert.equal(classifyBalance({ credits: 5000, balanceUsd: 0, autoTopUp: false }), 'ok');
  assert.match(formatBalanceLine([{ provider: 'genspark', credits: 124857.7, autoTopUp: null }]), /genspark 124857\.7cr\(前払い\)/);
});
