import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callWithFallback, classifyFailure, FALLBACK_CHAIN } from './llm-fallback.mjs';

const start = { provider: 'groq', model: 'model-a' };
const second = { provider: 'openrouter', model: 'model-b' };
const requestFor = () => ({ url: 'https://example.invalid', init: {} });

test('失敗分類は network と 5xx だけを再試行し、429 は次候補へ進める', () => {
  assert.equal(classifyFailure(null), 'retry');
  assert.equal(classifyFailure(500), 'retry');
  assert.equal(classifyFailure(599), 'retry');
  assert.equal(classifyFailure(429), 'next');
  assert.equal(classifyFailure(401), 'next');
});

test('Gemini demotion sends explicitly requested long context to OpenRouter first', async (t) => {
  const files = temporaryFiles(t);
  fs.writeFileSync(path.join(path.dirname(files.cooldownFile), 'routing-overrides.json'), JSON.stringify({ demote: { gemini: '2099-01-01T00:00:00Z' } }));
  const calls = [];
  const result = await callWithFallback({
    ...files, start: { provider: 'gemini', model: 'gemini-3.7-flash' }, chain: FALLBACK_CHAIN,
    payloadFor(candidate) { calls.push(candidate.provider); return requestFor(); },
    fetchImpl: async () => new Response('{}'),
  });
  assert.equal(result.candidate.provider, 'openrouter');
  assert.deepEqual(calls, ['openrouter']);
});

test('フォールバック候補は指定された順序である', () => {
  const providers = FALLBACK_CHAIN.map(({ provider }) => provider);
  assert.deepEqual(providers, ['groq', 'cerebras', 'glm', 'genspark', 'openrouter', 'deepseek', 'gemini', 'grok', 'kimi']);
  assert.ok(providers.indexOf('genspark') < providers.indexOf('openrouter'), 'Genspark Pro の前払いクレジットは従量課金より先に使う');
  assert.equal(providers[1], 'cerebras', 'Groq が 429 で落ちた直後は費用ゼロの Cerebras を先に試す');
  assert.equal(providers[2], 'glm', '失敗率の高い GLM は Cerebras の後ろに回す');
  assert.ok(providers.indexOf('grok') < providers.indexOf('kimi'));
  assert.ok(providers.indexOf('openrouter') < providers.indexOf('deepseek'), '自動チャージ可能なgatewayを直叩きより先にする');
  assert.ok(providers.indexOf('deepseek') < providers.indexOf('gemini'));
});

test('429 は同一候補に再試行せず1回で次候補へ進む', async (t) => {
  const files = temporaryFiles(t);
  const calls = []; const waits = [];
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor,
    ...files,
    fetchImpl: async () => { calls.push(true); return calls.length === 1 ? new Response('quota', { status: 429 }) : new Response('{}', { status: 200 }); },
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(calls.length, 2, '429 は容量不足なので同一プロバイダへ投げ直さない');
  assert.deepEqual(waits, []);
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

test('payloadFor が null の候補は HTTP を叩かずスキップ理由に記録する', async (t) => {
  const files = temporaryFiles(t); let calls = 0;
  await assert.rejects(
    callWithFallback({
      start, chain: [second], ...files,
      payloadFor: () => null,
      fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
    }),
    (error) => {
      assert.equal(calls, 0);
      assert.deepEqual(error.failures, []);
      assert.deepEqual(error.skipped, [
        { provider: 'groq', model: 'model-a', reason: 'no-request' },
        { provider: 'openrouter', model: 'model-b', reason: 'no-request' },
      ]);
      assert.match(error.message, /利用可能なキーを持つ候補がありません ; スキップ: groq\(no-request\), openrouter\(no-request\)$/);
      return true;
    },
  );
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

test('本文に billing を含むだけの通常429(groqのTPD)は24時間にしない', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  const body = 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD). Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
  await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response(body, { status: 429 }) : new Response('{}', { status: 200 }),
  });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.until, timestamp + 60_000, 'retry-after の無い通常の429は下限の60秒');
});

test('429 の cooldown は retry-after が短くても下限60秒を下回らない', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('quota', { status: 429, headers: { 'Retry-After': '1' } }) : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.until, timestamp + 60_000, 'retry-after: 1 でも次のジョブが即座に groq を叩かないよう60秒は空ける');
});

test('ORGIAST_LLM_429_COOLDOWN_MIN_MS で 429 の cooldown 下限を変更できる', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, original = process.env.ORGIAST_LLM_429_COOLDOWN_MIN_MS; let calls = 0;
  t.after(() => { if (original === undefined) delete process.env.ORGIAST_LLM_429_COOLDOWN_MIN_MS; else process.env.ORGIAST_LLM_429_COOLDOWN_MIN_MS = original; });
  process.env.ORGIAST_LLM_429_COOLDOWN_MIN_MS = '300000';
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('quota', { status: 429, headers: { 'Retry-After': '1' } }) : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.until, timestamp + 300_000);
});

test('402 はプロバイダを24時間クールダウンに記録する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp,
    fetchImpl: async () => ++calls === 1 ? new Response('payment', { status: 402 }) : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.deepEqual(state.groq, { until: timestamp + 24 * 60 * 60 * 1000, reason: 'http_402', at: timestamp });
});

test('DeepSeek直叩き402はOpenRouterの同モデルへ直ちに回す', async (t) => {
  const files = temporaryFiles(t), attempted = []; let calls = 0;
  const result = await callWithFallback({ start: { provider: 'deepseek', model: 'deepseek-chat' }, chain: [], ...files,
    payloadFor(candidate) { attempted.push(candidate); return requestFor(); },
    fetchImpl: async () => ++calls === 1 ? new Response('Insufficient Balance', { status: 402 }) : new Response('{}') });
  assert.deepEqual(attempted.map((x) => `${x.provider}:${x.model}`), ['deepseek:deepseek-chat', 'openrouter:deepseek/deepseek-v4-flash']);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('クールダウン中のプロバイダは payloadFor を呼ばずにスキップする', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, payloads = [];
  fs.writeFileSync(files.cooldownFile, JSON.stringify({ groq: { until: timestamp + 60_000, reason: 'http_429', at: timestamp } }));
  const result = await callWithFallback({ start, chain: [second], ...files, now: () => timestamp,
    payloadFor(candidate) { payloads.push(candidate.provider); return requestFor(); }, fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.deepEqual(payloads, ['openrouter']);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('クールダウン中の候補はスキップ理由と残り時間に記録する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000;
  fs.writeFileSync(files.cooldownFile, JSON.stringify({ groq: { until: timestamp + 61_000, reason: 'http_429', at: timestamp } }));
  await assert.rejects(
    callWithFallback({ start, chain: [second], ...files, now: () => timestamp,
      payloadFor: requestFor, fetchImpl: async () => new Response('denied', { status: 403 }) }),
    (error) => {
      assert.deepEqual(error.skipped, [{ provider: 'groq', model: 'model-a', reason: 'cooldown', minutesLeft: 2 }]);
      assert.match(error.message, /スキップ: groq\(cooldown, 残り2分\)$/);
      return true;
    },
  );
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

test('429 の Retry-After が下限60秒より短ければ下限を採用する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('quota', { status: 429, headers: { 'Retry-After': '5' } }) : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.until, timestamp + 60_000);
});

test('恒久的な課金切れの429はリトライせず次候補へ進む', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0; const waits = [];
  const result = await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp,
    sleepImpl: async (ms) => waits.push(ms),
    fetchImpl: async () => ++calls === 1
      ? new Response('{"error":{"message":"Your prepayment credits are depleted."}}', { status: 429 })
      : new Response('{}', { status: 200 }) });
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('恒久的な課金切れの429は24時間クールダウンに記録する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp,
    fetchImpl: async () => ++calls === 1
      ? new Response('{"error":{"message":"insufficient_quota"}}', { status: 429 })
      : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.deepEqual(state.groq, { until: timestamp + 24 * 60 * 60 * 1000, reason: 'http_429', at: timestamp });
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
