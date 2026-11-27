import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callWithFallback, FALLBACK_CHAIN, parseQuotaResetTime } from './llm-fallback.mjs';
import { nextUtcMidnight } from './lib/provider-daily-cooldown.mjs';

const start = { provider: 'groq', model: 'model-a' };
const second = { provider: 'openrouter', model: 'model-b' };
const requestFor = () => ({ url: 'https://example.invalid', init: {} });

test('フォールバック候補は指定された順序である', () => {
  const providers = FALLBACK_CHAIN.map(({ provider }) => provider);
  assert.deepEqual(providers, ['groq', 'glm', 'cerebras', 'genspark', 'openrouter', 'deepseek', 'kimi']);
  assert.ok(providers.indexOf('genspark') < providers.indexOf('openrouter'), 'Genspark Pro の前払いクレジットは従量課金より先に使う');
  assert.equal(providers[1], 'glm', '無料のGroqの次に定額のGLMを試す');
  assert.equal(providers[2], 'cerebras', '定額のCerebrasは従量プロバイダより先に試す');
  assert.ok(providers.indexOf('openrouter') < providers.indexOf('deepseek'), '自動チャージ可能なgatewayを直叩きより先にする');
  assert.ok(providers.indexOf('deepseek') < providers.indexOf('kimi'), 'DeepSeekはKimiより先');
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

  assert.equal(result.candidate.provider, 'openrouter');
  assert.deepEqual(failovers, [
    { from: 'groq', to: 'openrouter', reason: 'HTTP401: groq failure' },
    { from: 'openrouter', to: 'gemini', reason: 'HTTP402: openrouter failure' },
    { from: 'gemini', to: 'openrouter', reason: 'HTTP403: gemini failure' },
  ]);
});

function temporaryFiles(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cooldownFile: path.join(dir, 'cooldown.json'), ledgerFile: path.join(dir, 'ledger.jsonl'), budgetFile: path.join(dir, 'budget.json'), laneHealthFile: path.join(dir, 'lane-health.json') };
}

test('本文に billing を含むだけの通常429は日次上限と誤判定せず短時間クールダウンにする', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  const body = 'Rate limit reached for model `openai/gpt-oss-120b`. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
  await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls <= 3 ? new Response(body, { status: 429 }) : new Response('{}', { status: 200 }),
  });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.until, timestamp + 60_000, 'retry-after の無い通常の429は既定下限60秒');
});

test('日次回数上限(RPD/TPD)の429は同一候補をリトライせず次の安いAIへ回し、翌日UTC 0時まで退避する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; const seen = [];
  const body = 'Rate limit reached for model `openai/gpt-oss-120b` service tier on_demand on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 1m26.4s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => { throw new Error('should not wait to retry the same provider'); },
    fetchImpl: async () => {
      seen.push(true);
      return seen.length === 1 ? new Response(body, { status: 429 }) : new Response('{}', { status: 200 });
    },
  });
  assert.equal(seen.length, 2, 'groq は1回だけで次候補へ');
  assert.equal(result.candidate.provider, 'openrouter');
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.reason, 'daily_limit');
  assert.equal(state.groq.until, nextUtcMidnight(new Date(timestamp)));
});

test('TPD の429も日次退避し、チェーン内の次候補へ回す（Claude はチェーンに含めない）', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  const body = 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD). Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response(body, { status: 429 }) : new Response('{}', { status: 200 }),
  });
  assert.equal(calls, 2);
  assert.equal(result.candidate.provider, 'openrouter');
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.reason, 'daily_limit');
  assert.equal(state.groq.until, nextUtcMidnight(new Date(timestamp)));
});

test('lane-health.json の quota_wait 中のプロバイダは隔離ディレクトリで読み書きし実ホームを触らない', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000;
  // 隔離ディレクトリの lane-health.json に groq を quota_wait として設定
  fs.writeFileSync(files.laneHealthFile, JSON.stringify({ lanes: { groq: { alive: false, reason: 'quota_wait', until: timestamp + 300_000, probedAt: new Date(timestamp).toISOString() } } }));
  let calls = 0;
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200 }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('routing 先頭が quota_wait 中なら次の健全な候補を最初に呼ぶ', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, attempted = [];
  fs.writeFileSync(files.laneHealthFile, JSON.stringify({ lanes: { groq: { alive: false, reason: 'quota_wait', until: timestamp + 300_000 } } }));
  const result = await callWithFallback({
    start, chain: [second], ...files, now: () => timestamp,
    payloadFor(candidate) { attempted.push(candidate.provider); return requestFor(); },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  assert.deepEqual(attempted, ['openrouter']);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('全候補が quota_wait 中でも候補を復活させて呼ぶ', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, attempted = [];
  fs.writeFileSync(files.laneHealthFile, JSON.stringify({ lanes: {
    groq: { alive: false, reason: 'quota_wait', until: timestamp + 300_000 },
    openrouter: { alive: false, reason: 'quota_wait', until: timestamp + 300_000 },
  } }));
  const result = await callWithFallback({
    start, chain: [second], ...files, now: () => timestamp,
    payloadFor(candidate) { attempted.push(candidate.provider); return requestFor(); },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  assert.deepEqual(attempted, ['groq']);
  assert.equal(result.candidate.provider, 'groq');
});

test('明示指定した先頭候補は quota_wait 中でも警告して試行する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, attempted = [], errors = [];
  fs.writeFileSync(files.laneHealthFile, JSON.stringify({ lanes: { groq: { alive: false, reason: 'quota_wait', until: timestamp + 300_000 } } }));
  const original = console.error;
  console.error = message => errors.push(String(message));
  t.after(() => { console.error = original; });
  const result = await callWithFallback({
    start, chain: [second], explicitStart: true, ...files, now: () => timestamp,
    payloadFor(candidate) { attempted.push(candidate.provider); return requestFor(); },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  assert.deepEqual(attempted, ['groq']);
  assert.equal(result.candidate.provider, 'groq');
  assert.equal(errors.filter(line => line.includes('明示指定された groq は quota_wait 中')).length, 1);
});

test('429 で reset 時刻が本文から取れた場合 lane-health.json に quota_wait を書く', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp, sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1
      ? new Response('Your limit will reset at 2026-11-19 19:53:29', { status: 429 })
      : new Response('{}', { status: 200 }),
  });
  assert.ok(fs.existsSync(files.laneHealthFile), 'lane-health.json が隔離ディレクトリに作られる');
  const health = JSON.parse(fs.readFileSync(files.laneHealthFile, 'utf8'));
  assert.equal(health.lanes.groq.reason, 'quota_wait');
  assert.equal(health.lanes.groq.alive, false);
  assert.ok(health.lanes.groq.until > timestamp);
});

test('reset 時刻付きの枯渇系429は同一プロバイダを再試行しない', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000, attempted = [], waits = [];
  const result = await callWithFallback({
    start, chain: [second], ...files, now: () => timestamp,
    payloadFor(candidate) { attempted.push(candidate.provider); return requestFor(); },
    sleepImpl: async ms => waits.push(ms),
    fetchImpl: async () => attempted.length === 1
      ? new Response('{"error":{"message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-26 19:53:29"}}', { status: 429 })
      : new Response('{}', { status: 200 }),
  });
  assert.deepEqual(attempted, ['groq', 'openrouter']);
  assert.deepEqual(waits, []);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('一時的な429は従来どおり同一プロバイダを再試行する', async (t) => {
  const files = temporaryFiles(t); let calls = 0; const waits = [];
  const result = await callWithFallback({
    start, chain: [second], ...files,
    payloadFor: requestFor, sleepImpl: async ms => waits.push(ms),
    fetchImpl: async () => ++calls === 1
      ? new Response('rate limit; retry shortly', { status: 429, headers: { 'Retry-After': '1' } })
      : new Response('{}', { status: 200 }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(result.candidate.provider, 'groq');
  assert.equal(result.attempt, 1);
});

test('402 はプロバイダを24時間クールダウンに記録する', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp,
    fetchImpl: async () => ++calls === 1 ? new Response('payment', { status: 402 }) : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.deepEqual(state.groq, { until: timestamp + 24 * 60 * 60 * 1000, reason: 'http_402', at: timestamp });
});

for (const [provider, model, mapped] of [['kimi', 'kimi-k3', 'moonshotai/kimi-k3'], ['deepseek', 'deepseek-flash', 'deepseek/deepseek-v4-flash']]) {
  test(`${provider}: no-fallback and stale native cooldown still use OpenRouter first`, async t => {
    const files = temporaryFiles(t), attempted = [];
    fs.writeFileSync(files.cooldownFile, JSON.stringify({ [provider]: { until: Date.now() + 86400000, reason: 'http_402' } }));
    fs.writeFileSync(path.join(path.dirname(files.cooldownFile), 'routing-overrides.json'), JSON.stringify({ gatewayBeforeDirect: { [provider]: 'old/model' } }));
    for (const chain of [[], FALLBACK_CHAIN]) {
      const result = await callWithFallback({ start: { provider, model }, chain, allowGatewayFallback: false, ...files,
        payloadFor(candidate) { attempted.push(candidate); return requestFor(); }, fetchImpl: async () => new Response('{}') });
      assert.deepEqual(result.candidate, { provider: 'openrouter', model: mapped });
      assert.equal(result.failover, false);
    }
    assert.equal(attempted.length, 2);
    assert.ok(attempted.every(c => c.provider === 'openrouter' && c.model === mapped));
  });
}
test('fallback retains distinct OpenRouter models and deduplicates aliases', async t => {
  const attempted = [];
  const result = await callWithFallback({ start: second,
    chain: [{ provider: 'deepseek', model: 'deepseek-flash' }, { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' }, { provider: 'kimi', model: 'kimi-k3' }],
    ...temporaryFiles(t), payloadFor(candidate) { attempted.push(candidate); return requestFor(); },
    fetchImpl: async () => attempted.length < 3 ? new Response('not found', { status: 404 }) : new Response('{}') });
  assert.deepEqual(attempted.map(c => c.model), ['model-b', 'deepseek/deepseek-v4-flash', 'moonshotai/kimi-k3']);
  assert.equal(result.failover, true);
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

test('恒久的な課金切れの429は24時間 cooldown にする', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000; let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files, now: () => timestamp,
    fetchImpl: async () => ++calls === 1
      ? new Response('{"error":{"message":"insufficient_quota"}}', { status: 429 })
      : new Response('{}', { status: 200 }) });
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.deepEqual(state.groq, { until: timestamp + 24 * 60 * 60 * 1000, reason: 'http_429', at: timestamp, permanentBilling: true });
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

test('200応答が無効なら次候補へfailoverする', async (t) => {
  const files = temporaryFiles(t); let calls = 0; const attempts = [];
  const result = await callWithFallback({
    start, chain: [second], payloadFor: requestFor, ...files,
    fetchImpl: async () => new Response(JSON.stringify({ usable: ++calls > 1 })),
    validateResponse: (json) => json?.usable || '本文が不完全です',
    onAttempt: (info) => attempts.push({ provider: info.candidate.provider, status: info.status, failover: info.failover }),
  });
  assert.equal(result.candidate.provider, 'openrouter');
  assert.equal(result.failover, true);
  assert.deepEqual(attempts, [
    { provider: 'groq', status: 'unusable', failover: false },
    { provider: 'openrouter', status: 'ok', failover: true },
  ]);
});

test('全候補の200応答が無効ならunusable理由を集計する', async (t) => {
  const files = temporaryFiles(t);
  await assert.rejects(
    callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files,
      fetchImpl: async () => new Response('{}'), validateResponse: () => false }),
    (error) => {
      assert.match(error.message, /^全候補が失敗しました:/);
      assert.equal(error.failures.length, 2);
      assert.ok(error.failures.every(({ reason }) => /^unusable:/.test(reason)));
      return true;
    },
  );
});

test('全候補が失敗した場合のfailureにattemptを残す', async (t) => {
  const files = temporaryFiles(t);
  await assert.rejects(
    callWithFallback({ start, chain: [], payloadFor: requestFor, ...files,
      fetchImpl: async () => new Response('rate limited', { status: 429 }), sleepImpl: async () => {} }),
    (error) => {
      assert.equal(typeof error.failures[0].attempt, 'number');
      assert.equal(error.failures[0].attempt, 2);
      return true;
    },
  );
});

test('無効な200応答ではプロバイダをcooldownに記録しない', async (t) => {
  const files = temporaryFiles(t); let calls = 0;
  await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files,
    fetchImpl: async () => new Response(JSON.stringify({ usable: ++calls > 1 })), validateResponse: (json) => json.usable });
  const cooldowns = fs.existsSync(files.cooldownFile) ? JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8')) : {};
  assert.equal(cooldowns.groq, undefined);
});

test('validateResponse未指定なら200応答を従来どおり即返す', async (t) => {
  const files = temporaryFiles(t); let calls = 0;
  const result = await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files,
    fetchImpl: async () => { calls += 1; return new Response('JSONでない本文'); } });
  assert.equal(calls, 1);
  assert.equal(result.candidate.provider, 'groq');
});

test('HTTP 400応答ではvalidateResponseを呼ばない', async (t) => {
  const files = temporaryFiles(t); let calls = 0; let validations = 0;
  const result = await callWithFallback({ start, chain: [second], payloadFor: requestFor, ...files,
    fetchImpl: async () => ++calls === 1 ? new Response('bad request', { status: 400 }) : new Response('{"usable":true}'),
    validateResponse: () => { validations += 1; return true; },
  });
  assert.equal(result.candidate.provider, 'openrouter');
  assert.equal(validations, 1);
});

// --- A: 分窓トークン残量による「429 を受ける前」の事前迂回(2026-09-25 実測 TPM 8,000 が根拠) ---

const bigRequestFor = (vendor) => ({ url: `https://${vendor}.invalid`, init: { body: 'x'.repeat(8000) } });

test('残量が足りない候補は HTTP を叩かずに次候補へ回す(429 を受けてから避けない)', async (t) => {
  const files = temporaryFiles(t);
  fs.writeFileSync(files.budgetFile, JSON.stringify({ groq: { limitTokens: 8000, remainingTokens: 100, tokensResetAt: null, updatedAt: 0 } }));
  const hit = [];
  const result = await callWithFallback({
    start: { provider: 'groq', model: 'openai/gpt-oss-120b' },
    chain: [{ provider: 'cerebras', model: 'zai-glm-4.7' }],
    payloadFor: async (c) => bigRequestFor(c.provider),
    ...files,
    now: () => 1_700_000_000_000,
    fetchImpl: async (url) => { hit.push(url); return new Response('{}'); },
  });
  assert.deepEqual(hit, ['https://cerebras.invalid']); // groq は1度も叩かれない
  assert.equal(result.candidate.provider, 'cerebras');
  assert.equal(result.failover, true);
});

test('残量が足りていれば従来どおり先頭候補を使う', async (t) => {
  const files = temporaryFiles(t);
  fs.writeFileSync(files.budgetFile, JSON.stringify({ groq: { limitTokens: 8000, remainingTokens: 7000, tokensResetAt: null, updatedAt: 0 } }));
  const result = await callWithFallback({
    start: { provider: 'groq', model: 'openai/gpt-oss-120b' }, chain: [], payloadFor: async (c) => bigRequestFor(c.provider),
    ...files, now: () => 1_700_000_000_000, fetchImpl: async () => new Response('{}'),
  });
  assert.equal(result.candidate.provider, 'groq');
});

test('窓が明けていれば古い残量で締め切らない', async (t) => {
  const files = temporaryFiles(t);
  fs.writeFileSync(files.budgetFile, JSON.stringify({ groq: { limitTokens: 8000, remainingTokens: 100, tokensResetAt: 1_000, updatedAt: 0 } }));
  const result = await callWithFallback({
    start: { provider: 'groq', model: 'openai/gpt-oss-120b' }, chain: [], payloadFor: async (c) => bigRequestFor(c.provider),
    ...files, now: () => 2_000, fetchImpl: async () => new Response('{}'),
  });
  assert.equal(result.candidate.provider, 'groq');
});

test('応答ヘッダの残量を次回のために永続化する', async (t) => {
  const files = temporaryFiles(t);
  await callWithFallback({
    start: { provider: 'groq', model: 'openai/gpt-oss-120b' }, chain: [], payloadFor: requestFor,
    ...files, now: () => 1_700_000_000_000,
    fetchImpl: async () => new Response('{}', { headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7927', 'x-ratelimit-reset-tokens': '547ms' } }),
  });
  const store = JSON.parse(fs.readFileSync(files.budgetFile, 'utf8'));
  assert.equal(store.groq.remainingTokens, 7927);
  assert.equal(store.groq.limitTokens, 8000);
  assert.equal(store.groq.tokensResetAt, 1_700_000_000_000 + 547);
});

test('残量ヘッダを返さない provider は素通し(既存挙動を変えない)', async (t) => {
  const files = temporaryFiles(t);
  const result = await callWithFallback({
    start: { provider: 'cerebras', model: 'zai-glm-4.7' }, chain: [], payloadFor: async (c) => bigRequestFor(c.provider),
    ...files, now: () => 1_700_000_000_000, fetchImpl: async () => new Response('{}'),
  });
  assert.equal(result.candidate.provider, 'cerebras');
  assert.equal(fs.existsSync(files.budgetFile), false); // 書くものが無ければファイルも作らない
});

for (const [label, retryAfter, min, max, expected] of [
  ['14-hour header', '50400', undefined, undefined, 900000],
  ['HTTP date', new Date(1700000000000 + 50400000).toUTCString(), undefined, undefined, 900000],
  ['invalid header', 'invalid', undefined, undefined, 60000],
  ['zero header', '0', undefined, undefined, 60000],
  ['custom floor', '1', '120000', undefined, 120000],
  ['custom cap', '50400', undefined, '300000', 300000],
  ['cap wins over floor', '50400', '1800000', undefined, 900000],
  ['invalid cap', '50400', undefined, 'NaN', 900000],
]) test(`429 cooldown bounds: ${label}`, async (t) => {
  const files = temporaryFiles(t), timestamp = 1700000000000;
  for (const [name, value] of [['ORGIAST_LLM_429_COOLDOWN_MIN_MS', min], ['ORGIAST_LLM_429_COOLDOWN_MAX_MS', max]]) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await assert.rejects(callWithFallback({ start, chain: [second], ...files, now: () => timestamp,
    payloadFor: (candidate) => candidate.provider === 'groq' ? requestFor() : null,
    fetchImpl: async () => new Response('rate limit', { status: 429, headers: { 'retry-after': retryAfter } }), sleepImpl: async () => {} }));
  const state = JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8'));
  assert.equal(state.groq.until - state.groq.at, expected);
});

test('legacy 14-hour cooldown expires from original at and persists correction', async (t) => {
  const files = temporaryFiles(t), timestamp = 1700000000000, providers = [];
  fs.writeFileSync(files.cooldownFile, JSON.stringify({ groq: { at: timestamp - 3600000, until: timestamp + 50400000, reason: 'http_429' } }));
  await callWithFallback({ start, chain: [second], ...files, now: () => timestamp,
    payloadFor: (candidate) => { providers.push(candidate.provider); return requestFor(); },
    fetchImpl: async () => {
      assert.equal(JSON.parse(fs.readFileSync(files.cooldownFile, 'utf8')).groq.until, timestamp - 3600000 + 900000);
      return new Response('{}');
    } });
  assert.deepEqual(providers, ['groq']);
});
test('no-fallback probe records OpenRouter as the actual provider',async t=>{
  const calls=[];
  await assert.rejects(callWithFallback({start:{provider:'deepseek',model:'deepseek-flash'},chain:[],allowGatewayFallback:false,...temporaryFiles(t),payloadFor(candidate){calls.push(candidate.provider);return requestFor();},fetchImpl:async()=>new Response('payment required',{status:402}),sleepImpl:async()=>{}}));
  assert.deepEqual(calls,['openrouter']);
});

for (const hang of ['headers', 'body']) {
  test(`per-provider timeout advances once after hung ${hang}, including transports ignoring abort`, async () => {
    const calls = [], records = [], signals = [];
    const began = Date.now();
    const result = await callWithFallback({
      start, chain: [second], perProviderTimeoutMs: 40, persistState: false,
      payloadFor: requestFor,
      fetchImpl: async (_, init) => {
        calls.push(true); signals.push(init.signal);
        if (calls.length > 1) return new Response('{"ok":true}');
        if (hang === 'headers') return new Promise(() => {});
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
      },
      onAttempt: info => records.push(info.status),
    });
    assert.equal(result.candidate.provider, second.provider);
    assert.deepEqual(await result.response.json(), { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(signals[0].aborted, true);
    assert.deepEqual(records, ['timeout', 'ok']);
    assert.ok(Date.now() - began < 2000, 'fallback completes inside the parent budget');
  });
}

test('Retry-After waits share the provider deadline and cannot delay fallback', async () => {
  let calls = 0;
  const began = Date.now();
  const result = await callWithFallback({
    start, chain: [second], perProviderTimeoutMs: 40, persistState: false, payloadFor: requestFor,
    fetchImpl: async () => ++calls === 1 ? new Response('busy', { status: 503, headers: { 'retry-after': '60' } }) : new Response('{}'),
  });
  assert.equal(result.candidate.provider, second.provider);
  assert.equal(calls, 2);
  assert.ok(Date.now() - began < 2000);
});

test('all hung providers fail within their combined budget with timeout diagnostics', async () => {
  const began = Date.now();
  await assert.rejects(callWithFallback({
    start, chain: [second], perProviderTimeoutMs: 30, persistState: false,
    payloadFor: requestFor, fetchImpl: () => new Promise(() => {}),
  }), error => error.failures.length === 2 && error.failures.every(f => /timeout after 30ms/.test(f.reason)));
  assert.ok(Date.now() - began < 2000);
});

for (const explicit of [true, false]) {
  test(`transcript は${explicit ? '先頭指定' : '後続候補'}のDeepSeekとgatewayを除外`, async t => {
    const calls = [];
    const deepseek = { provider: 'deepseek', model: 'deepseek-flash' };
    const result = await callWithFallback({
      category: 'transcript', start: explicit ? deepseek : start,
      chain: [start, deepseek, { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' }, { provider: 'gemini', model: 'gemini-test' }],
      ...temporaryFiles(t),
      payloadFor(candidate) { calls.push(candidate.provider); return requestFor(); },
      fetchImpl: async () => calls.at(-1) === 'groq' ? new Response('fail', { status: 403 }) : new Response('{}'),
    });
    assert.deepEqual(calls, ['groq', 'gemini']);
    assert.equal(result.candidate.provider, 'gemini');
  });
}

test('transcript で DeepSeek しかない場合も禁止を解除しない', async t => {
  await assert.rejects(callWithFallback({ category: 'transcript', start: { provider: 'deepseek', model: 'deepseek-flash' }, chain: [],
    ...temporaryFiles(t), payloadFor: () => assert.fail('DeepSeekを呼ばない'),
  }));
});

test('parseQuotaResetTime: 本文から reset 時刻を解析', () => {
  const now = Date.parse("2026-11-19T00:00:00Z"); // 固定: Date.now() だと記載日時を過ぎると必ず失敗する
  // "Your limit will reset at 2026-11-19 19:53:29"
  const result = parseQuotaResetTime('Your limit will reset at 2026-11-19 19:53:29', now);
  assert.ok(result > now, '未来の時刻を返す');
  assert.equal(new Date(result).toISOString(), '2026-11-19T10:53:29.000Z'); // JST=+9 → UTC

  // "Your Monthly Limit will reset at 2026-11-19 21:24:00"
  const monthly = parseQuotaResetTime('Your Monthly Limit will reset at 2026-11-19 21:24:00', now);
  assert.ok(monthly > now);

  // 過去の時刻は null
  const past = parseQuotaResetTime('Your limit will reset at 2020-01-01 00:00:00', now);
  assert.equal(past, null);

  // reset 時刻を含まない本文は null
  const none = parseQuotaResetTime('Rate limit exceeded', now);
  assert.equal(none, null);
});

test('glm は provider-limit-history の until が未来なら payload を作らずにスキップする', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000;
  fs.writeFileSync(path.join(path.dirname(files.cooldownFile), 'provider-limit-history.jsonl'), `${JSON.stringify({ provider: 'glm', until: timestamp + 60_000, reason: 'usage_limit' })}\n`);
  const payloads = [];
  const result = await callWithFallback({
    start: { provider: 'glm', model: 'glm-5.3' }, chain: [second], ...files, now: () => timestamp,
    payloadFor(candidate) { payloads.push(candidate.provider); return requestFor(); },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  assert.deepEqual(payloads, ['openrouter']);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('deepseek 直URLは limit-history の間 fetch せず次候補を使う', async (t) => {
  const files = temporaryFiles(t), timestamp = 1_700_000_000_000;
  fs.writeFileSync(path.join(path.dirname(files.cooldownFile), 'provider-limit-history.jsonl'), `${JSON.stringify({ provider: 'deepseek', until: timestamp + 3_600_000, reason: 'http_402' })}\n`);
  const urls = [];
  const result = await callWithFallback({
    start: { provider: 'openrouter', model: 'deepseek/deepseek-chat' },
    chain: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }],
    ...files, now: () => timestamp,
    payloadFor(candidate) {
      return candidate.model.includes('deepseek')
        ? { url: 'https://api.deepseek.com/v1/chat/completions', init: {} }
        : { url: 'https://api.groq.com/openai/v1/chat/completions', init: {} };
    },
    fetchImpl: async (url) => { urls.push(String(url)); return new Response('{}', { status: 200 }); },
  });
  assert.deepEqual(urls, ['https://api.groq.com/openai/v1/chat/completions']);
  assert.equal(result.candidate.model, 'openai/gpt-oss-120b');
});

test('台帳行には category と caller が必ず入る', async (t) => {
  const files = temporaryFiles(t);
  await callWithFallback({
    start, chain: [], category: 'jp_reply', caller: 'unit', ...files,
    payloadFor: requestFor,
    fetchImpl: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200 }),
  });
  const row = JSON.parse(fs.readFileSync(files.ledgerFile, 'utf8'));
  assert.equal(row.category, 'jp_reply');
  assert.equal(row.caller, 'unit');
  assert.equal(row.tool, 'unit');
  assert.equal(row.in, 3);
  assert.equal(row.out, 4);
  assert.equal(row.status, 'ok');
});

test('台帳の http_429 はレーンの失敗率に入らない', (t) => {
  const files = temporaryFiles(t);
  const home = path.dirname(files.ledgerFile);
  const claudeDir = path.join(home, '.claude');
  const ledgerFile = path.join(claudeDir, 'executor-usage.jsonl');
  const now = new Date().toISOString();
  const rows = [
    ...Array.from({ length: 4 }, () => ({ t: now, provider: 'groq', status: 'http_429' })),
    ...['timeout', 'http_500', 'fail', 'ok', 'ok'].map((status) => ({ t: now, provider: 'cerebras', status })),
  ];
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(ledgerFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  // node --test 中に無効化される候補の健康判定を、一時ホームの子プロセスで通す。
  const env = { ...process.env, HOME: home, USERPROFILE: home, ORGIAST_HOME: home };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { callWithFallback } from ${JSON.stringify(new URL('./llm-fallback.mjs', import.meta.url).href)};
    await callWithFallback({
      start: ${JSON.stringify(start)}, chain: [],
      ...${JSON.stringify({ ...files, ledgerFile })},
      payloadFor: () => ({ url: 'https://example.invalid', init: {} }),
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
  `], { env });

  const disabled = JSON.parse(fs.readFileSync(path.join(claudeDir, 'lanes-disabled.json'), 'utf8'));
  assert.equal(disabled.cerebras.reason, 'failure_rate');
  assert.equal(disabled.groq, undefined);
});
