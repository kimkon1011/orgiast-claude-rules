import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { parseArgs, fetchLineMessages, check } from './auto-progress-external-check.mjs';
import { run } from './auto-progress-watch.mjs';
import { notificationMocks } from './test-helpers/auto-progress-home.mjs';
import { externalSpec, readEvents } from './lib/external-monitor-state.mjs';
import { readLedger, writeLedger, ledgerFile } from './auto-progress-ledger.mjs';
let homes = [];
after(() => homes.forEach(h => { try { fs.rmSync(h, { recursive: true, force: true }); } catch {} }));
const tmpHome = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-check-')); homes.push(h); return h; };
const now = Date.parse('2026-11-12T10:00:00Z');

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

test('check exits 1 with new messages (continuation), 1 without, 3 on error', async t => {
  const exitCode = process.exitCode;
  const log = console.log;
  t.after(() => { process.exitCode = exitCode; console.log = log; });
  const secrets = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' };

  // Test: no new messages → exit 1
  const noopFetch = () => ({ ok: true, json: async () => [], text: async () => '' });
  await check({ channel: 'line', threadId: 'g1', since: '2026-11-12T00:00:00Z', secrets, fetchImpl: noopFetch });
  assert.equal(process.exitCode, 1);

  // Test: new messages → exit 1 (unmet, for continuation) + ##EXTERNAL_RESULT## marker
  process.exitCode = -1;
  let stdout = '';
  const originalLog = console.log;
  console.log = (...args) => { stdout += args.join(' ') + '\n'; originalLog(...args); };
  const newFetch = () => ({ ok: true, json: async () => [{ id: 'm1', created_at: '2026-11-12T04:00:00Z', sender_display_name: '森田様', body: '案2で', direction: 'inbound' }], text: async () => '' });
  await check({ channel: 'line', threadId: 'g1', since: '2026-11-12T00:00:00Z', secrets, fetchImpl: newFetch });
  assert.equal(process.exitCode, 1);
  assert.ok(stdout.includes('##EXTERNAL_RESULT##'));
  const markerMatch = stdout.match(/##EXTERNAL_RESULT##(\{[\s\S]*?\})(?:\n|$)/);
  assert.ok(markerMatch, 'should have EXTERNAL_RESULT marker');
  const data = JSON.parse(markerMatch[1]);
  assert.equal(data.count, 1);
  assert.equal(data.messages[0].sender, '森田様');
  assert.equal(data.latestAt, '2026-11-12T04:00:00Z');
  assert.equal(data.channel, 'line');
  console.log = originalLog;

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

test('watch persists successive cursors only after inbox delivery and keeps monitoring across ticks', async () => {
  const home = tmpHome(), file = ledgerFile(home);
  const baseline = '2026-11-12T00:00:00Z';
  writeLedger(file, [{
    ts: new Date(now).toISOString(), pc: 'test', user: 'test', sessionId: 'external-session',
    cwd: home, status: 'open', label: 'LINE monitor',
    check: `node tools/auto-progress-external-check.mjs --channel line --thread-id g1 --since ${baseline}`,
    deadlineAt: new Date(now + 86400000).toISOString(),
  }]);
  const m1 = { id: 'm1', at: '2026-11-12T04:00:00Z', sender: 'customer', text: 'first' };
  const m2 = { id: 'm2', at: '2026-11-12T05:00:00Z', sender: 'customer', text: 'second' };
  let messages = [m1], failDelivery = true, tick = now;
  const delivered = [], cursors = [];
  const io = { ...notificationMocks, clock: () => tick, transcriptFiles: [], sheetConfig: () => null,
    digest: async () => ({}), escalateKimDecisions: async () => ({}),
    executeCheck: () => assert.fail('watch must use the durable external monitor'),
    fetchExternalMessages: async spec => { cursors.push(spec.since); return messages; },
    addKimInboxItem: async (_, item) => {
      if (item.source.endsWith('-error')) return { id: 'error' };
      if (failDelivery) return { id: 'pending', forwardError: 'offline' };
      assert.equal(item.kind, 'ask');
      delivered.push(item.dedupeKey);
      return { id: item.dedupeKey };
    },
    resume: async row => {
      assert.match(row.nextClaude, /社外送信は行わない/);
      return { state: 'progressed' };
    },
  };
  const poll = async () => {
    const result = await run({ home, now: tick, io });
    assert.deepEqual(result.errors, []);
    assert.equal(result.done, 0);
    const row = readLedger(file)[0];
    assert.equal(row.status, 'open');
    assert.equal(row.lastCheckedAt, new Date(tick).toISOString());
    tick += 30 * 60000;
    return externalSpec(row).since;
  };
  assert.equal(await poll(), baseline);
  failDelivery = false;
  assert.equal(await poll(), m1.at);
  messages = [m1, m2];
  assert.equal(await poll(), m2.at);
  messages = [m2];
  assert.equal(await poll(), m2.at);
  assert.deepEqual(cursors, [baseline, baseline, m1.at, m2.at]);
  assert.equal(delivered.length, 2);
  assert.equal(new Set(delivered).size, 2);
  assert.equal(readEvents(home).length, 2);
});
