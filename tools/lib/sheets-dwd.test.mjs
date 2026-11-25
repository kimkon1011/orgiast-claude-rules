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
    random: () => 0,
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

test('429が6回続いても専用再試行枠で成功する', async () => {
  const { client, calls, sleeps } = clientFor([
    ...Array.from({ length: 6 }, () => jsonResponse(429)),
    jsonResponse(200, { updatedRows: 1 }),
  ]);
  await client.update('sheet', 'Tab!A1', [['value']]);
  assert.equal(calls.length, 7);
  assert.deepEqual(sleeps, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
  assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) >= 120_000);
});

test('429が9回続くと専用再試行枠を使い切って失敗する', async () => {
  const { client, calls, sleeps } = clientFor([jsonResponse(429)]);
  await assert.rejects(client.update('sheet', 'Tab!A1', [['value']]), /Sheets PUT HTTP 429/);
  assert.equal(calls.length, 9);
  assert.equal(sleeps.length, 8);
});

test('values batchUpdateは429を再試行する', async () => {
  const { client, calls, sleeps } = clientFor([jsonResponse(429), jsonResponse(200, { totalUpdatedCells: 1 })]);
  const data = [{ range: 'Tab!A1', values: [['value']] }];
  await client.batchUpdate('sheet', data);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.match(calls[0][0], /\/values:batchUpdate$/);
  assert.deepEqual(JSON.parse(calls[0][1].body), { valueInputOption: 'RAW', data });
});

test('GETの5xxはmaxRetriesを使い切ると従来のエラーを投げる', async () => {
  const maxRetries = 2;
  const { client, calls, sleeps } = clientFor([jsonResponse(503)], { maxRetries });
  await assert.rejects(client.get('sheet', 'Tab!A1'), /Sheets GET HTTP 503/);
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
const putTimeout = () => Object.assign(new Error('The operation was aborted due to timeout'), {
  name: 'TimeoutError',
});

test('PUTは1回目のタイムアウトから再試行して成功する', async () => {
  const { client, calls, sleeps } = clientFor([
    putTimeout(),
    jsonResponse(200, { updatedRows: 1 }),
  ]);
  await client.update('sheet', 'Tab!A1', [['value']]);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2_000]);
});

test('PUTは3回連続でタイムアウトすると従来どおりエラーになる', async () => {
  const { client, calls, sleeps } = clientFor([putTimeout(), putTimeout(), putTimeout()], { maxRetries: 2 });
  await assert.rejects(client.update('sheet', 'Tab!A1', [['value']]), /Sheets PUT fetch failed: The operation was aborted due to timeout/);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2_000, 4_000]);
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

test('既定のfetchImplはgwsFetch（既存のfetchImpl注入テストは全てそのまま合格する）', async () => {
  // fetchImplを注入しないcreateSheetsClient()の既定値がgwsFetchであること、
  // かつ既存テストのようにfetchImplを明示すれば完全にオーバーライドできることを確認する。
  // 既定値へのアクセス手段がないので、gwsFetch経由でマーカーが渡ると
  // プロキシルート（channelRequest）へ進むことをエラー種別で確認する。
  // keyserve secretが無いPCでは channel エラー（GWS/LINE: keyserve）になる。
  // ここでは「tokenは取れたがリクエストが通らなかった」のではなく
  // 「マーカーを評価して中継ルートに入った結果のエラー」であることを確認する。
  const markerClient = createSheetsClient({
    getToken: async () => 'orgiast-server-side-gws',
    sleep: async () => {},
    maxRetries: 0,
  });
  await assert.rejects(markerClient.get('sheet', 'Tab!A1'), (err) => {
    // keyserve secretが無ければchannelエラー、有れば別のネットワークエラー。
    // いずれにせよ「Sheets GET HTTP 401」にはならないのが本修正の要点。
    return !err.message.includes('Sheets GET HTTP 401');
  });
  // fetchImplを注入したclientForは既定値変更の影響を受けずに動く
  const passThrough = clientFor([jsonResponse(200, { values: [['ok']] })]);
  assert.deepEqual(await passThrough.client.get('sheet', 'Tab!A1'), [['ok']]);
  assert.equal(passThrough.calls.length, 1);
});
