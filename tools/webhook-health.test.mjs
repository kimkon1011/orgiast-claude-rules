import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWebhooks, findReplacement, mergeLedger, redactSecrets } from './webhook-health.mjs';

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
