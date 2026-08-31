import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscordChannelRows } from './discord-channel-ledger.mjs';

test('buildDiscordChannelRows resolves categories, types, URLs, and deterministic order', () => {
  const rows = buildDiscordChannelRows([
    { id: '31', name: 'zeta', type: 99, position: 3, parent_id: '10' },
    { id: '2', name: 'general', type: 0, position: 2, parent_id: null },
    { id: '10', name: '開発', type: 4, position: 8, parent_id: null },
    { id: '30', name: 'alpha', type: 15, position: 1, parent_id: '10' },
    { id: '1', name: 'welcome', type: 5, position: 1, parent_id: null },
  ], 'guild', '2026-08-31');
  assert.deepEqual(rows.map((row) => row.id), ['1', '2', '10', '30', '31']);
  assert.equal(rows[2].category, '');
  assert.equal(rows[3].category, '開発');
  assert.equal(rows[3].type, 'フォーラム');
  assert.equal(rows[4].type, 'type:99');
  assert.equal(rows[3].parentId, '10');
  assert.equal(rows[3].url, 'https://discord.com/channels/guild/30');
});
