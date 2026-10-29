import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPersonalNumbers, toSheetRow, cursorFromSheet, selectNewMessages, attachmentPaths, formatJst } from './line-log-export.mjs';

test('masks exactly twelve digits, including full-width and multiple occurrences', () => {
  assert.equal(maskPersonalNumbers('123456789012'), '********9012');
  assert.equal(maskPersonalNumbers('12345678901 1234567890123'), '12345678901 1234567890123');
  assert.equal(maskPersonalNumbers('１２３４５６７８９０１２'), '********９０１２');
  assert.equal(maskPersonalNumbers('a123456789012 / 987654321098b'), 'a********9012 / ********1098b');
  assert.equal(maskPersonalNumbers('１２３４５６７８９０１ １２３４５６７８９０１２３'), '１２３４５６７８９０１ １２３４５６７８９０１２３');
  assert.equal(maskPersonalNumbers(null), '');
});

test('deduplicates against sheet and current batch without mutating existing IDs', () => {
  const existing = new Set(['old']);
  const messages = ['old', 'new', 'new', 'other'].map(external_message_id => ({ external_message_id }));
  assert.deepEqual(selectNewMessages(messages, existing), [messages[1], messages[3]]);
  assert.deepEqual([...existing], ['old']);
  assert.throws(() => selectNewMessages([{}], []), /external_message_id/);
});

test('cursor ignores headers and uses maximum JST time converted to UTC', () => {
  assert.equal(cursorFromSheet([]), '2026-10-01T00:00:00+09:00');
  assert.equal(cursorFromSheet([['受信日時(JST)']]), '2026-10-01T00:00:00+09:00');
  assert.equal(cursorFromSheet([['受信日時(JST)'], ['2026-10-30 01:02:03'], ['2026-10-29 23:59:59']]), '2026-10-29T16:02:03.000Z');
});

test('attachment paths exclude HTTP and token URLs', () => {
  assert.equal(attachmentPaths([{ url: 'https://example.com/a?token=secret' }, { url: 'line-media/2026/10/x.jpg' },
    { url: 'HTTP://example.com/x' }, { url: 'line-media/x?token=secret' }, null, {}, { url: 'line-media/y.png' }]),
  'line-media/2026/10/x.jpg\nline-media/y.png');
  assert.equal(attachmentPaths(null), '');
});

test('JST formatting handles UTC offsets and midnight', () => {
  assert.equal(formatJst('2026-10-29T15:02:03Z'), '2026-10-30 00:02:03');
  assert.equal(formatJst('2026-10-30T00:02:03+09:00'), '2026-10-30 00:02:03');
  assert.throws(() => formatJst('bad'), /timestamp/);
});

test('sheet rows preserve column order and mask all three personal text fields', () => {
  const msg = { received_at: '2026-10-29T15:02:03Z', subject: 'LINE: グループ123456789012', external_thread_id: 'thread',
    sender_display_name: '人１２３４５６７８９０１２', direction: 'inbound', body: '=123456789012',
    attachments: [{ url: 'line-media/2026/10/x.jpg' }], external_message_id: 'message' };
  assert.deepEqual(toSheetRow(msg), ['2026-10-30 00:02:03', 'グループ********9012', 'thread', '人********９０１２',
    'inbound', '=********9012', 'line-media/2026/10/x.jpg', 'message']);
  assert.equal(toSheetRow({ ...msg, body: 'a'.repeat(45001) })[5].length, 45000);
  assert.equal(toSheetRow({ ...msg, subject: 'Other LINE: group' })[1], 'Other LINE: group');
});
