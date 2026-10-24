import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWebhooks, findReplacement, mergeLedger, redactSecrets, postWebhookSheet } from './webhook-health.mjs';

const deadUrl = `https://discord.com/api/webhooks/1508767136301191329/${'a'.repeat(40)}`;
const aliveUrl = `https://discord.com/api/webhooks/1539927619674570752/${'B'.repeat(40)}`;

test('指定の正規表現でwebhook URLを抽出する', () => {
  assert.deepEqual(extractWebhooks(`A=${deadUrl}\nshort=https://discord.com/api/webhooks/123/x`), [
    { url: deadUrl, webhookId: '1508767136301191329' },
  ]);
});

test('生存確認結果を既存台帳へマージし、tokenは保存しない', () => {
  const merged = mergeLedger(
    { old: { channelId: '1', files: ['/old'] } },
    [{ webhookId: '1539927619674570752', url: aliveUrl, channelId: '1508437329247862794', channelName: 'orgiast-notify' }],
    { '1539927619674570752': ['/a.env'] },
    '2026-08-25T00:00:00.000Z',
  );
  assert.equal(merged['1539927619674570752'].lastSeenAliveAt, '2026-08-25T00:00:00.000Z');
  assert.deepEqual(merged['1539927619674570752'].files, ['/a.env']);
  assert.equal(JSON.stringify(merged).includes('B'.repeat(40)), false);
  assert.ok(merged.old);
});

test('置換候補は同一チャンネルの生存webhookだけ', () => {
  const ledger = {
    dead: { channelId: 'channel-a' },
    same: { channelId: 'channel-a', lastSeenAliveAt: '2026-08-25T00:00:00Z' },
    other: { channelId: 'channel-b', lastSeenAliveAt: '2026-08-26T00:00:00Z' },
  };
  const alive = [
    { webhookId: 'other', channelId: 'channel-b', url: 'other' },
    { webhookId: 'same', channelId: 'channel-a', url: 'same' },
  ];
  assert.equal(findReplacement('dead', ledger, alive)?.webhookId, 'same');
  assert.equal(findReplacement('unknown', ledger, alive), null);
});

test('ログ用マスクはtokenを一切残さない', () => {
  const message = redactSecrets(`fetch failed: ${deadUrl}`);
  assert.equal(message.includes('a'.repeat(40)), false);
  assert.match(message, /1508767136301191329\/\[REDACTED\]/);
});

const sheetResponse = (body, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });

test('HTTP 200 busy はバックオフ後に同じ台帳payloadを再送する（最大3試行）', async () => {
  const requests = [], waits = [];
  const payload = { token: 'test-token', kind: 'webhooks', label: 'pc', checkedAt: '2026-10-25', webhooks: [{ webhookId: '123', state: 'alive', files: ['a.env'] }] };
  const success = { ok: true, updated: 1, appended: 0 };
  const result = await postWebhookSheet('https://example.invalid/sheet', payload, {
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request });
      return sheetResponse(requests.length < 3 ? { ok: false, status: 503, error: 'busy' } : success);
    },
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.deepEqual(result, success);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.url, 'https://example.invalid/sheet');
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'follow');
    assert.deepEqual(JSON.parse(request.body), payload);
  }
});

test('busy が続いても3試行で終了し最後の失敗理由を保持する', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(postWebhookSheet('unused', {}, {
    fetchImpl: async () => { calls++; return sheetResponse({ ok: false, error: 'busy' }); },
    sleepImpl: async (ms) => waits.push(ms),
  }), /fleet sheet rejected request: busy/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('HTTP 503 の明示的な busy 応答も再試行する', async () => {
  let calls = 0;
  const result = await postWebhookSheet('unused', {}, {
    fetchImpl: async () => ++calls === 1 ? sheetResponse({ ok: false, error: 'busy' }, 503) : sheetResponse({ ok: true }),
    sleepImpl: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('成功・恒久的な拒否・不正JSON・通信失敗は再送しない', async (t) => {
  for (const [name, response, error] of [
    ['success', sheetResponse({ ok: true }), null],
    ['rejected', sheetResponse({ ok: false, error: 'unauthorized' }), /rejected request: unauthorized/],
    ['http', sheetResponse({ ok: false, error: 'busy' }, 403), /HTTP 403/],
    ['invalid JSON', { ok: true, text: async () => '<html>' }, /invalid JSON/],
    ['network', null, /network unavailable/],
  ]) await t.test(name, async () => {
    let calls = 0;
    const pending = postWebhookSheet('unused', {}, {
      fetchImpl: async () => { calls++; if (!response) throw new Error('network unavailable'); return response; },
      sleepImpl: async () => assert.fail('must not wait'),
    });
    if (error) await assert.rejects(pending, error);
    else assert.deepEqual(await pending, { ok: true });
    assert.equal(calls, 1);
  });
});

test('シートの拒否理由に含まれるwebhook秘密を伏せる', async () => {
  await assert.rejects(postWebhookSheet('unused', {}, {
    fetchImpl: async () => sheetResponse({ ok: false, error: deadUrl }),
  }), (error) => !error.message.includes('a'.repeat(40)) && error.message.includes('[REDACTED]'));
});
