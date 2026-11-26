import test from 'node:test';
import assert from 'node:assert/strict';
import { findSecretaryBookingUrls, SECRETARY_BOOKING_URL_REASON } from './secretary-booking-url.mjs';

test('秘書の空き日程URLと /secretary 配下を検出する', () => {
  for (const url of [
    'https://claude-pc.tailc5d751.ts.net/secretary/book',
    'http://claude-pc.tailc5d751.ts.net/secretary',
    'https://claude-pc.tailc5d751.ts.net/secretary/',
    'https://claude-pc.tailc5d751.ts.net/secretary/other',
    'claude-pc.tailc5d751.ts.net/secretary/book?date=1',
    'HTTPS://Claude-PC.tailc5d751.ts.net/Secretary/Book',
    'https%3A%2F%2Fclaude-pc.tailc5d751.ts.net%2Fsecretary%2Fbook',
  ]) {
    const found = findSecretaryBookingUrls(`候補はこちら ${url} です`);
    assert.equal(found.length, 1, url);
    assert.match(found[0], /secretary/i);
  }
  assert.match(SECRETARY_BOOKING_URL_REASON, /候補日時/);
  assert.match(SECRETARY_BOOKING_URL_REASON, /別日を聞く/);
});

test('秘書以外の同一ホストと、ホストのない文言は送ってよい', () => {
  for (const text of [
    '',
    null,
    '11月20日 10:00 と 11月21日 14:00 はいかがでしょうか。',
    'https://claude-pc.tailc5d751.ts.net/line-setup',
    'https://claude-pc.tailc5d751.ts.net/api/line-ingest?t=token',
    'https://claude-pc.tailc5d751.ts.net/secretaryship',
    '手順は secretary/book を社内で見る',
  ]) assert.deepEqual(findSecretaryBookingUrls(text), []);
});
