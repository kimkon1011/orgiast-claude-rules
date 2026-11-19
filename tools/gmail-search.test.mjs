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
  return { user: 'test@orgiast.jp', query: 'newer_than:1d', max: 3, fetchImpl, getToken: async () => 'test-token' };
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

test('個別取得の500はtransientとして再試行後にスキップする', async () => {
  const result = await searchGmail(searchOptions(async (url) => {
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }, { id: '2' }, { id: '3' }], resultSizeEstimate: 3 });
    if (url.includes('/messages/2?')) return jsonResponse({ error: 'server error' }, 500);
    const id = url.match(/\/messages\/(\d+)\?/u)?.[1];
    return jsonResponse(message(id));
  }));
  // Message 2 was retried then skipped (transient)
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].id, '1');
  assert.equal(result.messages[1].id, '3');
  assert.equal(result.skipped, 1);
});

test('一覧取得自体の404は握りつぶさずthrowする', async () => {
  await assert.rejects(
    searchGmail(searchOptions(async () => jsonResponse({ error: 'not found' }, 404))),
    (error) => error.status === 404 && /^Gmail API 404:/u.test(error.message),
  );
});

test('個別取得のタイムアウトは再試行後にスキップして残りを返す', async () => {
  const keepAlive = setTimeout(() => {}, 500); // AbortSignal.timeout keeps no event loop
  let attempts = 0;
  const result = await searchGmail(searchOptions(async (url) => {
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }, { id: '2' }, { id: '3' }], resultSizeEstimate: 3 });
    if (url.includes('/messages/2?')) {
      attempts++;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    const id = url.match(/\/messages\/(\d+)\?/u)?.[1];
    return jsonResponse(message(id));
  }));
  clearTimeout(keepAlive);
  // Message 2 was retried once then skipped (attempts=2 = initial + retry)
  assert.equal(attempts, 2);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].id, '1');
  assert.equal(result.messages[1].id, '3');
  assert.equal(result.skipped, 1);
});

test('全メッセージがタイムアウトしてもthrowせず空結果を返す', async () => {
  const keepAlive = setTimeout(() => {}, 500);
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const result = await searchGmail(searchOptions(async (url) => {
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }, { id: '2' }], resultSizeEstimate: 2 });
    throw timeout;
  }));
  clearTimeout(keepAlive);
  // All messages retried and skipped — no throw, empty result
  assert.deepEqual(result.messages, []);
  assert.equal(result.skipped, 2);
});

test('個別取得の500はtransientなら再試行後にスキップする', async () => {
  const keepAlive = setTimeout(() => {}, 500);
  const result = await searchGmail(searchOptions(async (url) => {
    if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: '1' }, { id: '2' }], resultSizeEstimate: 2 });
    if (url.includes('/messages/1?')) throw Object.assign(new Error('Gmail API 500: server error'), { status: 500 });
    return jsonResponse(message('2'));
  }));
  clearTimeout(keepAlive);
  assert.deepEqual(result.messages.map(({ id }) => id), ['2']);
  assert.equal(result.skipped, 1);
});
