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
