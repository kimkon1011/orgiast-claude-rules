import assert from 'node:assert/strict';
import test from 'node:test';
import { searchGmail } from './gmail-search.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function message(id) {
  return { id, threadId: `thread-${id}`, snippet: `message ${id}`, payload: { headers: [] } };
}

function searchOptions(fetchImpl) {
  return { user: 'test@orgiast.jp', query: 'newer_than:1d', max: 3, fetchImpl, sleepImpl: async () => {}, getToken: async () => 'test-token' };
}

test('個別取得の404だけをスキップして残りを返す', async () => {
  const warnings = [];
  const originalError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    const result = await searchGmail(searchOptions(async (url) => {
      if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }, { id: '2' }, { id: '3' }], resultSizeEstimate: 3 });
      if (url.includes('/messages/2?')) return jsonResponse({ error: 'not found' }, 404);
      const id = url.match(/\/messages\/(\d+)\?/u)?.[1];
      return jsonResponse(message(id));
    }));

    assert.deepEqual(result.messages.map(({ id }) => id), ['1', '3']);
    assert.equal(result.skipped, 1);
    assert.equal(warnings.length, 1);
  } finally {
    console.error = originalError;
  }
});

test('個別取得の410もスキップする', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await searchGmail(searchOptions(async (url) => {
      if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }, { id: '2' }, { id: '3' }], resultSizeEstimate: 3 });
      if (url.includes('/messages/2?')) return jsonResponse({ error: 'gone' }, 410);
      const id = url.match(/\/messages\/(\d+)\?/u)?.[1];
      return jsonResponse(message(id));
    }));

    assert.deepEqual(result.messages.map(({ id }) => id), ['1', '3']);
    assert.equal(result.skipped, 1);
  } finally {
    console.error = originalError;
  }
});

test('個別取得の500は握りつぶさずthrowする', async () => {
  await assert.rejects(
    searchGmail(searchOptions(async (url) => {
      if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }, { id: '2' }, { id: '3' }], resultSizeEstimate: 3 });
      if (url.includes('/messages/2?')) return jsonResponse({ error: 'server error' }, 500);
      return jsonResponse(message('1'));
    })),
    (error) => error.status === 500 && /^Gmail API 500:/u.test(error.message),
  );
});

test('一覧取得自体の404は握りつぶさずthrowする', async () => {
  await assert.rejects(
    searchGmail(searchOptions(async () => jsonResponse({ error: 'not found' }, 404))),
    (error) => error.status === 404 && /^Gmail API 404:/u.test(error.message),
  );
});

test('getTokenのTimeoutErrorを3回再試行する', async () => {
  let attempts = 0;
  await assert.rejects(
    searchGmail({ user: 'test@orgiast.jp', query: 'newer_than:1d', max: 3, sleepImpl: async () => {},
      fetchImpl: async () => { throw new Error('unreachable'); },
      getToken: async () => {
        attempts++;
        const error = new Error('fetch failed');
        error.name = 'TimeoutError';
        throw error;
      },
    }),
    (error) => /fetch failed/u.test(error.message) && error.name === 'TimeoutError',
  );
  assert.equal(attempts, 3);
});

test('getTokenの3回目成功まで再試行する', async () => {
  let attempts = 0;
  const result = await searchGmail({
    user: 'test@orgiast.jp', query: 'newer_than:1d', max: 3, sleepImpl: async () => {},
    getToken: async () => { attempts++; if (attempts < 3) { const e = new Error('fetch failed'); e.name = 'TimeoutError'; throw e; } return 'test-token'; },
    fetchImpl: async (url) => {
      if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }], resultSizeEstimate: 1 });
      return jsonResponse(message('1'));
    },
  });
  assert.equal(attempts, 3);
  assert.equal(result.messages.length, 1);
});

test('個別取得のECONNRESETを2回再試行し3回目で成功する', async () => {
  let listCalled = false, fetchAttempts = 0;
  const result = await searchGmail(searchOptions(async (url) => {
    if (url.includes('/messages?')) { listCalled = true; return jsonResponse({ messages: [{ id: '1' }], resultSizeEstimate: 1 }); }
    fetchAttempts++;
    if (fetchAttempts < 3) { throw Object.assign(new Error('fetch failed'), { name: 'TypeError', cause: { code: 'ECONNRESET' } }); }
    return jsonResponse(message('1'));
  }));
  assert.ok(listCalled);
  assert.equal(fetchAttempts, 3);
  assert.equal(result.messages.length, 1);
});

test('個別取得の429も再試行する', async () => {
  let count429 = 0;
  const result = await searchGmail(searchOptions(async (url) => {
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }], resultSizeEstimate: 1 });
    count429++;
    if (count429 === 1) return jsonResponse({ error: 'rate limit' }, 429);
    return jsonResponse(message(url.match(/\/messages\/(\d+)\?/u)?.[1]));
  }));
  assert.equal(result.messages.length, 1);
  assert.ok(count429 >= 1); // at least one 429 was retried and succeeded
});

test('個別取得5xxも再試行する', async () => {
  let fetchAttempts = 0;
  const result = await searchGmail(searchOptions(async (url) => {
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }], resultSizeEstimate: 1 });
    fetchAttempts++;
    if (fetchAttempts < 3) return jsonResponse({ error: 'server error' }, 502);
    return jsonResponse(message('1'));
  }));
  assert.equal(fetchAttempts, 3);
  assert.equal(result.messages.length, 1);
});

test('トークンのHTTP 429と直接のEAI_AGAINを再試行し、待機時間を倍増する', async () => {
  const delays = [], signals = [];
  await searchGmail({
    ...searchOptions(async () => jsonResponse({ messages: [] })),
    signal: new AbortController().signal,
    sleepImpl: async ms => { delays.push(ms); },
    getToken: async ({ signal }) => {
      signals.push(signal);
      if (signals.length === 1) throw Object.assign(new Error('rate limit'), { status: 429 });
      if (signals.length === 2) throw Object.assign(new Error('DNS'), { code: 'EAI_AGAIN' });
      return 'test-token';
    },
  });
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(new Set(signals).size, 3);
});

test('レスポンス本文のタイムアウト後も新しいsignalで再試行する', async () => {
  const signals = [];
  const result = await searchGmail({
    ...searchOptions(async (_url, { signal }) => {
      signals.push(signal);
      return signals.length === 1 ? { ok: true, json: () => new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      }) } : jsonResponse({ messages: [] });
    }),
    timeoutMs: 10,
    sleepImpl: async () => { await new Promise(resolve => setTimeout(resolve, 0)); },
  });
  assert.deepEqual(result.messages, []);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].reason.name, 'TimeoutError');
  assert.equal(signals[1].aborted, false);
});

test('バックオフ中に呼び出し元が中断したら再試行しない', async () => {
  const controller = new AbortController();
  const reason = new Error('source cancelled');
  let attempts = 0;
  await assert.rejects(searchGmail({
    ...searchOptions(async () => { attempts++; throw new TypeError('fetch failed'); }),
    signal: controller.signal,
    sleepImpl: () => {
      controller.abort(reason);
      return new Promise(() => {});
    },
  }), error => error === reason);
  assert.equal(attempts, 1);
});
