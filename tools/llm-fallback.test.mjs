import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callWithFallback, FALLBACK_CHAIN } from './llm-fallback.mjs';

const start = { provider: 'groq', model: 'model-a' };
const second = { provider: 'openrouter', model: 'model-b' };
const requestFor = () => ({ url: 'https://example.invalid', init: {} });

test('フォールバック候補は指定された順序である', () => {
  const providers = FALLBACK_CHAIN.map(({ provider }) => provider);
  assert.deepEqual(providers, ['groq', 'glm', 'cerebras', 'deepseek', 'openrouter', 'gemini', 'grok', 'kimi']);
  assert.equal(providers[1], 'glm', '無料のGroqの次に定額のGLMを試す');
  assert.equal(providers[2], 'cerebras', '定額のCerebrasは従量プロバイダより先に試す');
  assert.ok(providers.indexOf('grok') < providers.indexOf('kimi'));
  // 実測(2026-08-20)で openrouter 402・gemini 429 が常態化していたため、
  // 実際に生きている最安の前払い(deepseek)を死んでいる無料枠より前に出す。
  assert.ok(providers.indexOf('deepseek') < providers.indexOf('openrouter'));
  assert.ok(providers.indexOf('deepseek') < providers.indexOf('gemini'));
});

test('429 は同一候補で2回リトライしてから次候補へ進む', async (t) => {
  const files = temporaryFiles(t);
  const calls = []; const waits = [];
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor,
    ...files,
    fetchImpl: async () => { calls.push(true); return calls.length <= 3 ? new Response('quota', { status: 429 }) : new Response('{}', { status: 200 }); },
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('402 はリトライも待機もせず次候補へ進む', async (t) => {
  const files = temporaryFiles(t);
  let calls = 0; const waits = [];
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor,
    ...files,
    fetchImpl: async () => ++calls === 1 ? new Response('payment', { status: 402 }) : new Response('{}', { status: 200 }),
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('次候補の成功は試行台帳に failover:true で渡される', async (t) => {
  const files = temporaryFiles(t);
  const ledger = []; let calls = 0;
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor,
    ...files,
    fetchImpl: async () => ++calls === 1 ? new Response('bad key', { status: 401 }) : new Response('{}', { status: 200 }),
    onAttempt: (record) => ledger.push({ provider: record.candidate.provider, status: record.status, attempt: record.attempt, failover: record.failover }),
  });
  assert.equal(result.failover, true);
  assert.deepEqual(ledger, [
    { provider: 'groq', status: 'http_401', attempt: 0, failover: false },
    { provider: 'openrouter', status: 'ok', attempt: 0, failover: true },
  ]);
});

test('全候補失敗の要約に候補ごとの理由を含む', async (t) => {
  const files = temporaryFiles(t);
  await assert.rejects(
    callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, fetchImpl: async () => new Response('denied', { status: 403 }) }),
    (error) => error.message.includes('groq:model-a HTTP403') && error.message.includes('openrouter:model-b HTTP403'),
  );
});

test('キー未設定相当の候補はエラーにせず飛ばす', async (t) => {
  const files = temporaryFiles(t);
  const called = [];
  const result = await callWithFallback({
    start, chain: [second],
    ...files,
    payloadFor(candidate) { return candidate.provider === 'groq' ? null : requestFor(); },
    fetchImpl: async () => { called.push(true); return new Response('{}', { status: 200 }); },
  });
  assert.equal(called.length, 1);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('3候補が連続失敗した場合は候補自身の理由で3ホップを記録する', async (t) => {
  const files = temporaryFiles(t);
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
    ...files,
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

function temporaryFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cooldownFile: path.join(dir, 'cooldown.json'), ledgerFile: path.join(dir, 'ledger.jsonl') };
}

test('402 はプロバイダを6時間クールダウンに記録する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp,
    fetchImpl: async () => ++calls === 1 ? new Response('payment', { status: 402 }) : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.deepEqual(state.groq, { until: timestamp + 6 * 60 * 60 * 1000, reason: 'http_402', at: timestamp });
});

test('クールダウン中のプロバイダは payloadFor を呼ばずにスキップする', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, payloads = [];
  fs.writeFileSync(files.cooldownFile, JSON.stringify({ groq: { until: timestamp + 60_000, reason: 'http_429', at: timestamp } }));
  const result = await callWithFallback({ start, chain: [second], ...files, now: () => timestamp,
    payloadFor(candidate) { payloads.push(candidate.provider); return requestFor(); }, fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.deepEqual(payloads, ['openrouter']);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('全候補がクールダウン中なら無視して全候補を試す', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, payloads = []; let calls = 0;
  fs.writeFileSync(files.cooldownFile, JSON.stringify({ groq: { until: timestamp + 60_000 }, openrouter: { until: timestamp + 60_000 } }));
  const result = await callWithFallback({ start, chain: [second], ...files, now: () => timestamp,
    payloadFor(candidate) { payloads.push(candidate.provider); return requestFor(); },
    fetchImpl: async () => ++calls === 1 ? new Response('denied', { status: 403 }) : new Response('{}', { status: 200 }) });
  assert.deepEqual(payloads, ['groq', 'openrouter']);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('429 の Retry-After をクールダウン秒数に使う', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('quota', { status: 429, headers: { 'Retry-After': '120' } }) : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.until, timestamp + 120_000);
});

test('成功したプロバイダのクールダウンを削除する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000;
  fs.writeFileSync(files.cooldownFile, JSON.stringify({ groq: { until: timestamp - 1, reason: 'http_429', at: timestamp - 2 } }));
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.equal(JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8')).groq, undefined);
});

test('日次概算が hard cap 超過なら fetch 前に停止する', async (t) => {
  const files = temporaryFiles(t), timestamp = Date.now(); let calls = 0;
  fs.writeFileSync(files.ledgerFile, `${JSON.stringify({ t: new Date(timestamp).toISOString(), provider: 'grok', in: 0, out: 1_000_000 })}\n`);
  await assert.rejects(callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp,
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); } }), /本日の従量上限/);
  assert.equal(calls, 0);
});

test('warn cap 超過でも処理を続行する', async (t) => {
  const files = temporaryFiles(t), timestamp = Date.now(), original = process.env.ORGIAST_LLM_DAILY_HARD_USD;
  t.after(() => { if (original === undefined) delete process.env.ORGIAST_LLM_DAILY_HARD_USD; else process.env.ORGIAST_LLM_DAILY_HARD_USD = original; });
  process.env.ORGIAST_LLM_DAILY_HARD_USD = '20';
  fs.writeFileSync(files.ledgerFile, `${JSON.stringify({ t: new Date(timestamp).toISOString(), provider: 'grok', in: 500_000, out: 0 })}\n`);
  const result = await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.equal(result.candidate.provider, 'groq');
});

test('壊れたクールダウンJSONでも処理を続行する', async (t) => {
  const files = temporaryFiles(t); fs.writeFileSync(files.cooldownFile, '{broken');
  const result = await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.equal(result.candidate.provider, 'groq');
});

test('node --test では cooldownFile 未指定でも実ホームへ書き込まない', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fallback-'));
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const cooldownPath = path.join(dir, '.claude', 'provider-cooldown.json');
  const originalHome = process.env.ORGIAST_HOME;
  t.after(() => {
    if (originalHome === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = originalHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.ORGIAST_HOME = dir;

  let calls = 0;
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ledgerFile,
    fetchImpl: async () => ++calls === 1 ? new Response('payment', { status: 402 }) : new Response('{}', { status: 200 }),
  });

  assert.equal(result.candidate.provider, 'openrouter');
  assert.equal(fs.existsSync(cooldownPath), false);
});
