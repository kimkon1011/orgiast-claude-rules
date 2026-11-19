import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableError, retryAfterMs, backoffDelayMs, gmailFetchWithRetry } from './gmail-retry.mjs';

function fakeResponse(status, body, headers = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: name => headers[name] || null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

test('isRetryableError: 429 はリトライ対象', () => {
  assert.ok(isRetryableError(fakeResponse(429, '{}'), '{}'));
});
test('isRetryableError: 403 Quota exceeded はリトライ対象', () => {
  assert.ok(isRetryableError(fakeResponse(403, 'Quota exceeded for quota metric'), 'Quota exceeded for quota metric'));
});
test('isRetryableError: 403 rateLimitExceeded はリトライ対象', () => {
  assert.ok(isRetryableError(fakeResponse(403, 'rateLimitExceeded'), 'rateLimitExceeded'));
});
test('isRetryableError: 403 userRateLimitExceeded はリトライ対象', () => {
  assert.ok(isRetryableError(fakeResponse(403, 'userRateLimitExceeded'), 'userRateLimitExceeded'));
});
test('isRetryableError: 403 権限エラーはリトライ対象外', () => {
  assert.ok(!isRetryableError(fakeResponse(403, 'Request had insufficient authentication scopes'), 'Request had insufficient authentication scopes'));
});
test('isRetryableError: 500 はリトライ対象', () => {
  assert.ok(isRetryableError(fakeResponse(500, 'Internal Server Error'), 'Internal Server Error'));
});
test('isRetryableError: 502 はリトライ対象', () => {
  assert.ok(isRetryableError(fakeResponse(502, 'Bad Gateway'), 'Bad Gateway'));
});
test('isRetryableError: 200 はリトライ対象外', () => {
  assert.ok(!isRetryableError(fakeResponse(200, 'ok'), 'ok'));
});
test('isRetryableError: 404 はリトライ対象外', () => {
  assert.ok(!isRetryableError(fakeResponse(404, 'Not Found'), 'Not Found'));
});

test('retryAfterMs: Retry-After ヘッダーからミリ秒を取得', () => {
  assert.equal(retryAfterMs(fakeResponse(429, '', { 'Retry-After': '2' })), 2000);
  assert.equal(retryAfterMs(fakeResponse(429, '', { 'Retry-After': '0' })), 0);
  assert.equal(retryAfterMs(fakeResponse(429, '', {})), 0);
});

test('backoffDelayMs: 指数バックオフ + jitter（random 注入で固定）', () => {
  const random = () => 0.5; // jitter = 1 + 0.5 * 0.2 = 1.1
  assert.equal(backoffDelayMs(1, { random }), Math.round(5000 * 1.1));
  assert.equal(backoffDelayMs(2, { random }), Math.round(15000 * 1.1));
  assert.equal(backoffDelayMs(3, { random }), Math.round(45000 * 1.1));
  assert.equal(backoffDelayMs(4, { random }), Math.round(45000 * 1.1), '4回目は最大遅延を使う');
});

test('gmailFetchWithRetry: 403 Quota exceeded → 2回目 200 で成功し sleep が1回呼ばれる', async () => {
  const calls = [];
  let attempt = 0;
  const fetchImpl = async () => {
    attempt++;
    if (attempt === 1) return fakeResponse(403, 'Quota exceeded for quota metric');
    return fakeResponse(200, '{"data":"ok"}');
  };
  const sleeps = [];
  const sleep = ms => { sleeps.push(ms); };
  const retries = [];
  const onRetry = (n, d) => { retries.push({ n, d }); };
  const response = await gmailFetchWithRetry('https://example.com', {}, { fetchImpl, sleep, onRetry });
  const body = await response.json();
  assert.deepEqual(body, { data: 'ok' });
  assert.equal(sleeps.length, 1, 'sleep が1回呼ばれる');
  assert.ok(sleeps[0] > 0, '待ち時間が正の値');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].n, 1);
});

test('gmailFetchWithRetry: 429 + Retry-After: 2 → 2000ms 待つ', async () => {
  let attempt = 0;
  const fetchImpl = async () => {
    attempt++;
    if (attempt === 1) return fakeResponse(429, 'Too Many Requests', { 'Retry-After': '2' });
    return fakeResponse(200, '{"data":"ok"}');
  };
  const sleeps = [];
  const sleep = ms => { sleeps.push(ms); };
  await gmailFetchWithRetry('https://example.com', {}, { fetchImpl, sleep });
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 2000, 'Retry-After の値（秒→ミリ秒）で待つ');
});

test('gmailFetchWithRetry: 403 権限エラーはリトライせず即 throw', async () => {
  const fetchImpl = async () => fakeResponse(403, 'Request had insufficient authentication scopes');
  const sleeps = [];
  const sleep = ms => { sleeps.push(ms); };
  await assert.rejects(
    () => gmailFetchWithRetry('https://example.com', {}, { fetchImpl, sleep }),
    error => {
      assert.match(error.message, /^Gmail API 403:/);
      assert.match(error.message, /insufficient authentication scopes/);
      return true;
    }
  );
  assert.equal(sleeps.length, 0, 'リトライしないので sleep は呼ばれない');
});

test('gmailFetchWithRetry: 4回連続 quota 403 → throw しエラーメッセージは Gmail API 403: で始まる', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return fakeResponse(403, 'Quota exceeded for quota metric');
  };
  const sleeps = [];
  const sleep = ms => { sleeps.push(ms); };
  await assert.rejects(
    () => gmailFetchWithRetry('https://example.com', {}, { fetchImpl, sleep }),
    error => {
      assert.match(error.message, /^Gmail API 403:/);
      assert.match(error.message, /Quota exceeded/);
      return true;
    }
  );
  assert.equal(count, 4, '最大4回試行する');
  assert.equal(sleeps.length, 3, '3回リトライしたので sleep は3回');
});

test('gmailFetchWithRetry: 待ち合計が90秒を超えたら打ち切る', async () => {
  const fetchImpl = async () => fakeResponse(429, 'Too Many Requests', { 'Retry-After': '45' });
  const sleeps = [];
  const sleep = ms => { sleeps.push(ms); };
  await assert.rejects(
    () => gmailFetchWithRetry('https://example.com', {}, { fetchImpl, sleep }),
    error => {
      assert.match(error.message, /^Gmail API 429:/);
      return true;
    }
  );
  // 45s + 45s = 90s で上限に達するので2回目で打ち切り
  assert.ok(sleeps.length <= 2, '90秒上限で打ち切られる');
});

test('gmailFetchWithRetry: リトライ毎に新しい AbortSignal が使われる', async () => {
  const signals = [];
  let attempt = 0;
  const fetchImpl = async (_url, options) => {
    attempt++;
    signals.push(options.signal);
    if (attempt === 1) return fakeResponse(429, 'Too Many Requests');
    return fakeResponse(200, '{}');
  };
  await gmailFetchWithRetry('https://example.com', {}, { fetchImpl, sleep: async () => {} });
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1], '毎回新しい AbortSignal が作られる');
});