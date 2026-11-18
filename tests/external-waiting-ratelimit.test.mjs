import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Response の再現用: node-fetch 非依存、最小限の Response ライク
function fakeResponse({ status, body = '', headers = {} }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

describe('external-waiting Gmail API rate-limit retry', () => {
  it('403 rateLimitExceeded → 1回リトライ後200で成功しsleepが呼ばれる', async () => {
    const { scanMailbox } = await import('../tools/external-waiting.mjs');
    const sleep = mock.fn(() => Promise.resolve());
    let callCount = 0;
    const fetchImpl = mock.fn(() => {
      callCount++;
      // 最初のget(threads)で403、リトライで200。token取得はscanMailbox内でgetTokenで済んでいるのでここに出ない。
      // 初回のget(/threads...)で 403 → リトライで200 → 空スレッド →後の内部getは呼ばれないので、callCount 1→2→3で200。
      if (callCount <= 2) return Promise.resolve(fakeResponse({ status: 403, body: '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}' }));
      return Promise.resolve(fakeResponse({ status: 200, body: '{}' }));
    });
    const getToken = mock.fn(() => Promise.resolve('tok'));
    const result = await scanMailbox('test@example.com', { fetchImpl, getToken, staff: new Set(), now: Date.now(), sleep });
    assert.ok(Array.isArray(result));
    assert.ok(sleep.mock.callCount() >= 1, 'sleep should be called on retry');
  });

  it('429 + Retry-After:3 → sleep(3000)が呼ばれる', async () => {
    const { scanMailbox } = await import('../tools/external-waiting.mjs');
    const slept = [];
    const sleep = mock.fn(ms => { slept.push(ms); return Promise.resolve(); });
    const calls = [];
    const fetchImpl = mock.fn(() => {
      calls.push(calls.length);
      if (calls.length <= 2) return Promise.resolve(fakeResponse({ status: 429, body: 'rate limit', headers: { 'retry-after': '3' } }));
      return Promise.resolve(fakeResponse({ status: 200, body: '{}' }));
    });
    const getToken = mock.fn(() => Promise.resolve('tok'));
    await scanMailbox('test@example.com', { fetchImpl, getToken, staff: new Set(), now: Date.now(), sleep });
    assert.ok(slept.some(ms => ms === 3000), `expected sleep(3000) but got ${JSON.stringify(slept)}`);
  });

  it('403 insufficientPermissions → 再試行せず即throw（sleep 0回）', async () => {
    const { scanMailbox } = await import('../tools/external-waiting.mjs');
    const sleep = mock.fn(() => Promise.resolve());
    const fetchImpl = mock.fn(() => Promise.resolve(fakeResponse({ status: 403, body: '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}' })));
    const getToken = mock.fn(() => Promise.resolve('tok'));
    await assert.rejects(() => scanMailbox('test@example.com', { fetchImpl, getToken, staff: new Set(), now: Date.now(), sleep }), /Gmail API 403/);
    assert.equal(sleep.mock.callCount(), 0, 'sleep should NOT be called for non-retryable 403');
  });

  it('6回連続429 → throw、sleep 5回', async () => {
    const { scanMailbox } = await import('../tools/external-waiting.mjs');
    const sleep = mock.fn(() => Promise.resolve());
    const fetchImpl = mock.fn(() => Promise.resolve(fakeResponse({ status: 429, body: 'rate limit' })));
    const getToken = mock.fn(() => Promise.resolve('tok'));
    await assert.rejects(() => scanMailbox('test@example.com', { fetchImpl, getToken, staff: new Set(), now: Date.now(), sleep }), /Gmail API 429/);
    assert.equal(sleep.mock.callCount(), 5, 'should retry 5 times then throw');
  });
});