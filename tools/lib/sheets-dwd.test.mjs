import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsClient } from './sheets-dwd.mjs';

const jsonResponse = (status, body = {}, headers = new Headers()) => ({
  ok: status >= 200 && status < 300,
  status,
  headers,
  json: async () => body,
});

function clientFor(responses, options = {}) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (response instanceof Error) throw response;
    return response;
  };
  const client = createSheetsClient({
    fetchImpl,
    getToken: async () => 'token',
    sleep: async (ms) => sleeps.push(ms),
    ...options,
  });
  return { client, calls, sleeps };
}

test('GETは429から指数待機で再試行して成功する', async () => {
  const { client, calls, sleeps } = clientFor([
    jsonResponse(429),
    jsonResponse(429),
    jsonResponse(200, { values: [['ok']] }),
  ]);
  assert.deepEqual(await client.get('sheet', 'Tab!A1'), [['ok']]);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2_000, 4_000]);
});

test('PUTはRetry-After秒を待って再試行する', async () => {
  const headers = new Headers({ 'Retry-After': '7' });
  const { client, calls, sleeps } = clientFor([
    jsonResponse(429, {}, headers),
    jsonResponse(200, { updatedRows: 1 }),
  ]);
  await client.update('sheet', 'Tab!A1', [['value']]);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [7_000]);
});

test('POSTは429でも再試行しない', async () => {
  const { client, calls, sleeps } = clientFor([jsonResponse(429)]);
  await assert.rejects(client.append('sheet', 'Tab!A1', [['value']]), /Sheets POST HTTP 429/);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('GETはmaxRetriesを使い切ると従来のエラーを投げる', async () => {
  const maxRetries = 2;
  const { client, calls, sleeps } = clientFor([jsonResponse(429)], { maxRetries });
  await assert.rejects(client.get('sheet', 'Tab!A1'), /Sheets GET HTTP 429/);
  assert.equal(calls.length, maxRetries + 1);
  assert.deepEqual(sleeps, [2_000, 4_000]);
});

test('400は再試行しない', async () => {
  const { client, calls, sleeps } = clientFor([jsonResponse(400)]);
  await assert.rejects(client.get('sheet', 'Tab!A1'), /Sheets GET HTTP 400/);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

const connectTimeout = () => Object.assign(new TypeError('fetch failed'), {
  cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
});

test('GETは一時的な通信例外から指数待機で再試行して成功する', async () => {
  const { client, calls, sleeps } = clientFor([
    connectTimeout(),
    jsonResponse(200, { values: [['ok']] }),
  ]);
  assert.deepEqual(await client.get('sheet', 'Tab!A1'), [['ok']]);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test('POSTは一時的な通信例外でも再試行しない', async () => {
  const error = connectTimeout();
  const { client, calls, sleeps } = clientFor([error]);
  await assert.rejects(client.append('sheet', 'Tab!A1', [['value']]), (thrown) => thrown === error);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('GETは通信例外でmaxRetriesを使い切ると最後の例外をそのまま投げる', async () => {
  const maxRetries = 2;
  const errors = [connectTimeout(), connectTimeout(), connectTimeout()];
  const { client, calls, sleeps } = clientFor(errors, { maxRetries });
  await assert.rejects(client.get('sheet', 'Tab!A1'), (thrown) => thrown === errors.at(-1));
  assert.equal(calls.length, maxRetries + 1);
  assert.deepEqual(sleeps, [2_000, 4_000]);
});
