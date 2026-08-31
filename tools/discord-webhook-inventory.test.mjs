import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryRows } from './discord-webhook-inventory.mjs';

test('buildInventoryRows は秘密フィールドを捨てる', () => {
  const markerA = 'secret-field-a';
  const markerB = 'secret-field-b';
  const rows = buildInventoryRows([{ id: '1', name: '通知', channel_id: '2', token: markerA, url: markerB, user: { username: 'alice' } }]);
  assert.deepEqual(rows, [{ webhookId: '1', name: '通知', channelId: '2', channelName: '', creator: 'alice', state: 'alive' }]);
  assert(!JSON.stringify(rows).includes(markerA));
  assert(!JSON.stringify(rows).includes(markerB));
});

test('作成者が無い webhook でも落ちない', () => {
  assert.equal(buildInventoryRows([{ id: '1', channel_id: '2' }])[0].creator, '');
});

test('channelNames から名前を解決し、無ければ空文字', () => {
  assert.equal(buildInventoryRows([{ id: '1', channel_id: '2' }], { channelNames: { 2: '案件' } })[0].channelName, '案件');
  assert.equal(buildInventoryRows([{ id: '1', channel_id: '3' }], { channelNames: { 2: '案件' } })[0].channelName, '');
});
