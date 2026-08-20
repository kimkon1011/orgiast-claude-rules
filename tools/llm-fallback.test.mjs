import test from 'node:test';
import assert from 'node:assert/strict';
import { callWithFallback, FALLBACK_CHAIN } from './llm-fallback.mjs';

const start = { provider: 'groq', model: 'model-a' };
const second = { provider: 'openrouter', model: 'model-b' };
const requestFor = () => ({ url: 'https://example.invalid', init: {} });

test('フォールバック候補は指定された順序である', () => {
  const providers = FALLBACK_CHAIN.map(({ provider }) => provider);
  assert.deepEqual(providers, ['groq', 'openrouter', 'gemini', 'deepseek', 'grok', 'kimi']);
  assert.ok(providers.indexOf('grok') < providers.indexOf('kimi'));
});

test('429 は同一候補で2回リトライしてから次候補へ進む', async () => {
  const calls = []; const waits = [];
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor,
    fetchImpl: async () => { calls.push(true); return calls.length <= 3 ? new Response('quota', { status: 429 }) : new Response('{}', { status: 200 }); },
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('402 はリトライも待機もせず次候補へ進む', async () => {
  let calls = 0; const waits = [];
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor,
    fetchImpl: async () => ++calls === 1 ? new Response('payment', { status: 402 }) : new Response('{}', { status: 200 }),
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('次候補の成功は試行台帳に failover:true で渡される', async () => {
  const ledger = []; let calls = 0;
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor,
    fetchImpl: async () => ++calls === 1 ? new Response('bad key', { status: 401 }) : new Response('{}', { status: 200 }),
    onAttempt: (record) => ledger.push({ provider: record.candidate.provider, status: record.status, attempt: record.attempt, failover: record.failover }),
  });
  assert.equal(result.failover, true);
  assert.deepEqual(ledger, [
    { provider: 'groq', status: 'http_401', attempt: 0, failover: false },
    { provider: 'openrouter', status: 'ok', attempt: 0, failover: true },
  ]);
});

test('全候補失敗の要約に候補ごとの理由を含む', async () => {
  await assert.rejects(
    callWithFallback({ start, chain: [second], payloadFor: requestFor, fetchImpl: async () => new Response('denied', { status: 403 }) }),
    (error) => error.message.includes('groq:model-a HTTP403') && error.message.includes('openrouter:model-b HTTP403'),
  );
});

test('キー未設定相当の候補はエラーにせず飛ばす', async () => {
  const called = [];
  const result = await callWithFallback({
    start, chain: [second],
    payloadFor(candidate) { return candidate.provider === 'groq' ? null : requestFor(); },
    fetchImpl: async () => { called.push(true); return new Response('{}', { status: 200 }); },
  });
  assert.equal(called.length, 1);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('3候補が連続失敗した場合は候補自身の理由で3ホップを記録する', async () => {
  const candidates = [
    start,
    second,
    { provider: 'gemini', model: 'model-c' },
    { provider: 'deepseek', model: 'model-d' },
  ];
  const responses = [
    new Response('groq failure', { status: 401 }),
    new Response('openrouter failure', { status: 402 }),
    new Response('gemini\n failure', { status: 403 }),
    new Response('{}', { status: 200 }),
  ];
  const failovers = [];
  const result = await callWithFallback({
    start,
    chain: candidates.slice(1),
    payloadFor: requestFor,
    fetchImpl: async () => responses.shift(),
    onFailover: ({ from, to, reason }) => failovers.push({ from: from.provider, to: to.provider, reason }),
  });

  assert.equal(result.candidate.provider, 'deepseek');
  assert.deepEqual(failovers, [
    { from: 'groq', to: 'openrouter', reason: 'HTTP401: groq failure' },
    { from: 'openrouter', to: 'gemini', reason: 'HTTP402: openrouter failure' },
    { from: 'gemini', to: 'deepseek', reason: 'HTTP403: gemini failure' },
  ]);
});
