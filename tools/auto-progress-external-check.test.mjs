import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs, fetchLineMessages, check } from './auto-progress-external-check.mjs';

test('parseArgs requires all flags', () => {
  assert.throws(() => parseArgs([]), /--channel.*--thread-id.*--since/);
  assert.throws(() => parseArgs(['--channel', 'line']), /--thread-id.*--since/);
  assert.throws(() => parseArgs(['--channel', 'line', '--thread-id', 'g1']), /--since/);
  assert.throws(() => parseArgs(['--channel', 'line', '--thread-id', 'g1', '--since', 'invalid']), /有効な ISO/);
  // 必要な引数が全部揃った状態で channel 検証を通す
  assert.throws(() => parseArgs(['--channel', 'invalid', '--thread-id', 'x', '--since', '2026-11-12T00:00:00Z']), /未対応チャネル/);
  const opts = parseArgs(['--channel', 'line', '--thread-id', 'g1', '--since', '2026-11-12T00:00:00Z', '--home', '/tmp']);
  assert.equal(opts.channel, 'line');
  assert.equal(opts.threadId, 'g1');
  assert.equal(opts.since, '2026-11-12T00:00:00Z');
  assert.equal(opts.home, '/tmp');
});

test('fetchLineMessages filters external messages after since', async () => {
  const fake = url => {
    assert.ok(url.includes('external_thread_id=eq.g1'));
    assert.ok(url.includes('created_at=gt.2026-11-12'));
    const ok = body => ({ ok: true, json: async () => body, text: async () => '' });
    return ok([
      { id: 'm1', created_at: '2026-11-12T04:00:00Z', sender_display_name: '森田様', body: '案2でお願いします', direction: 'inbound' },
      { id: 'm2', created_at: '2026-11-12T03:00:00Z', sender_display_name: 'オージャスト', body: '送信しました', direction: 'outbound' },
      { id: 'm3', created_at: '2026-11-12T05:00:00Z', sender_display_name: '池永様', body: '①〜⑧の回答です', direction: 'inbound' },
    ]);
  };
  const secrets = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  const messages = await fetchLineMessages(secrets, 'g1', '2026-11-12T00:00:00Z', { fetchImpl: fake });
  assert.equal(messages.length, 2); // outbound excluded
  assert.equal(messages[0].sender, '森田様');
  assert.equal(messages[1].sender, '池永様');
});

test('check exits 0 with new messages, 1 without, 3 on error', async () => {
  const secrets = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' };

  // Test: no new messages → exit 1
  const noopFetch = () => ({ ok: true, json: async () => [], text: async () => '' });
  await check({ channel: 'line', threadId: 'g1', since: '2026-11-12T00:00:00Z', secrets, fetchImpl: noopFetch });
  assert.equal(process.exitCode, 1);

  // Test: new messages → exit 0
  process.exitCode = -1;
  const newFetch = () => ({ ok: true, json: async () => [{ id: 'm1', created_at: '2026-11-12T04:00:00Z', sender_display_name: '森田様', body: '案2で', direction: 'inbound' }], text: async () => '' });
  await check({ channel: 'line', threadId: 'g1', since: '2026-11-12T00:00:00Z', secrets, fetchImpl: newFetch });
  assert.equal(process.exitCode, 0);

  // Test: Supabase error → exit 3
  process.exitCode = -1;
  const errFetch = () => ({ ok: false, status: 500, text: async () => 'Internal Server Error' });
  await check({ channel: 'line', threadId: 'g1', since: '2026-11-12T00:00:00Z', secrets, fetchImpl: errFetch });
  assert.equal(process.exitCode, 3);

  // Test: no credentials → exit 3
  process.exitCode = -1;
  await check({ channel: 'line', threadId: 'g1', since: '2026-11-12T00:00:00Z', secrets: {}, fetchImpl: noopFetch });
  assert.equal(process.exitCode, 3);

  // Clean up exit code so the test runner doesn't see a failure
  process.exitCode = 0;
});