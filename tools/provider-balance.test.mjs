import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyBalance, collectProviderBalances, fetchProviderBalance, formatBalanceLine } from './provider-balance.mjs';

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

test('Groq の課金台帳が無料枠表示まで伝わり、異常判定は維持される', async t => {
  const home = mkdtempSync(join(tmpdir(), 'provider-billing-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const rows = await collectProviderBalances({ home, appendHistory: false, fetchImpl: async () => new Response('{}') });
  const groq = rows.find(r => r.provider === 'groq');
  assert.equal(groq.billing, 'free');
  assert.match(groq.reason, /high demand.*2026-09-09.*spend_anomaly.*429/);
  assert.equal(formatBalanceLine([groq]), '💳 残高: groq 無料枠(有料化不可)');
  assert.equal(classifyBalance({ ...groq, todaySpendUsd: 2, avg7dSpendUsd: 0.1 }), 'anomaly');
  assert.match(formatBalanceLine([{ ...groq, billing: 'postpaid' }]), /自動不明/);
});
