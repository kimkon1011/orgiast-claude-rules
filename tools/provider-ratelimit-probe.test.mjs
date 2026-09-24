import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  formatProbeLine, loadProbeKey, main, mergeMeasurement, parseRateLimitHeaders, probeRateLimits,
} from './provider-ratelimit-probe.mjs';

// 2026-09-25 に groq から実際に返ってきたヘッダをそのまま固定値として使う(実測の回帰点)。
const GROQ_HEADERS = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-limit-tokens': '8000',
  'x-ratelimit-remaining-requests': '866',
  'x-ratelimit-remaining-tokens': '7927',
  'x-ratelimit-reset-requests': '3h12m57.6s',
  'x-ratelimit-reset-tokens': '547ms',
};

function response(headers, { ok = true, status = 200, body = { usage: { total_tokens: 73 } } } = {}) {
  return { ok, status, headers: new Headers(headers), json: async () => body };
}

test('parseRateLimitHeaders は上限/残量を数値化し reset は生文字列で残す', () => {
  const parsed = parseRateLimitHeaders(new Headers(GROQ_HEADERS));
  assert.equal(parsed.limitRequests, 1000);
  assert.equal(parsed.limitTokens, 8000);
  assert.equal(parsed.remainingTokens, 7927);
  // "547ms" / "3h12m57.6s" は単位が実装依存なので変換しない
  assert.equal(parsed.resetTokens, '547ms');
  assert.equal(parsed.resetRequests, '3h12m57.6s');
});

test('parseRateLimitHeaders はヘッダが無ければ null(上限非開示の provider)', () => {
  assert.equal(parseRateLimitHeaders(new Headers({ 'x-request-id': 'req_1' })), null);
  assert.equal(parseRateLimitHeaders(null), null);
});

test('parseRateLimitHeaders は素の object でも動く', () => {
  assert.equal(parseRateLimitHeaders({ 'x-ratelimit-limit-tokens': '8000' }).limitTokens, 8000);
});

test('probeRateLimits は groq の実測ヘッダを limits として返す', async () => {
  const entry = await probeRateLimits({
    provider: 'groq',
    key: 'k',
    fetchImpl: async () => response(GROQ_HEADERS),
    now: () => Date.parse('2026-09-25T00:00:00Z'),
  });
  assert.equal(entry.ok, true);
  assert.equal(entry.limits.limitTokens, 8000);
  assert.equal(entry.limits.remainingTokens, 7927);
  assert.equal(entry.at, '2026-09-25T00:00:00.000Z');
});

test('probeRateLimits は max_tokens:1 で1コールだけ投げる', async () => {
  const calls = [];
  await probeRateLimits({
    provider: 'groq',
    key: 'k',
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return response(GROQ_HEADERS); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.max_tokens, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
});

test('probeRateLimits はキーが無ければ通信せず理由を返す', async () => {
  const entry = await probeRateLimits({ provider: 'groq', key: '', fetchImpl: async () => { throw new Error('呼んではいけない'); } });
  assert.equal(entry.ok, false);
  assert.match(entry.reason, /GROQ_API_KEY/);
});

test('probeRateLimits は 200 でもヘッダが無ければ「上限非開示」と明示する', async () => {
  const entry = await probeRateLimits({ provider: 'groq', key: 'k', fetchImpl: async () => response({ 'x-request-id': 'r' }) });
  assert.equal(entry.ok, true);
  assert.equal(entry.limits, null);
  assert.match(entry.reason, /x-ratelimit/);
});

test('probeRateLimits は失敗を握りつぶさず status と retryAfter を残す', async () => {
  const entry = await probeRateLimits({
    provider: 'groq', key: 'k',
    fetchImpl: async () => response({ 'retry-after': '30' }, { ok: false, status: 429 }),
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.status, 429);
  assert.equal(entry.retryAfter, '30');
  assert.match(entry.reason, /HTTP 429/);
});

test('未知の provider は例外にする(黙って別 provider を叩かない)', async () => {
  await assert.rejects(() => probeRateLimits({ provider: 'nope', key: 'k' }), /未知の provider/);
});

test('loadProbeKey は env を優先し、無ければ ~/.claude/<keyFile> を読む', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  assert.equal(loadProbeKey('groq', { home, env: { GROQ_API_KEY: 'from-env' } }), 'from-env');
  assert.equal(loadProbeKey('groq', { home, env: {} }), '');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'groq.env'), '# comment\nexport GROQ_API_KEY="from-file"\n');
  assert.equal(loadProbeKey('groq', { home, env: {} }), 'from-file');
  fs.rmSync(home, { recursive: true, force: true });
});

test('mergeMeasurement は provider/model ごとに最新値だけ残す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const file = path.join(home, '.claude', 'provider-ratelimits.json');
  mergeMeasurement(file, { provider: 'groq', model: 'openai/gpt-oss-120b', ok: false, at: 't1' });
  mergeMeasurement(file, { provider: 'groq', model: 'openai/gpt-oss-120b', ok: true, at: 't2' });
  mergeMeasurement(file, { provider: 'cerebras', model: 'zai-glm-4.7', ok: true, at: 't3' });
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(store['groq/openai/gpt-oss-120b'].at, 't2');
  assert.equal(Object.keys(store).length, 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('main はキー欠落時に 1 を返し、測定結果は残す(無音成功にしない)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const code = await main(['--provider', 'groq'], { home });
  assert.equal(code, 1);
  const store = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'provider-ratelimits.json'), 'utf8'));
  assert.equal(store['groq/openai/gpt-oss-120b'].ok, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('formatProbeLine は上限を1行で読める形にする', () => {
  const line = formatProbeLine({ provider: 'groq', model: 'm', ok: true, limits: parseRateLimitHeaders(new Headers(GROQ_HEADERS)) });
  assert.match(line, /TPM 8000/);
  assert.match(line, /残 7927/);
  assert.match(line, /RPD 1000/);
});
