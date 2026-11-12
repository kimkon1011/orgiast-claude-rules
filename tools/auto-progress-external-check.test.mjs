import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { parseArgs, fetchLineMessages, check } from './auto-progress-external-check.mjs';
import { checkPromise } from './auto-progress-check.mjs';
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

test('check exits 1 with new messages (continuation), 1 without, 3 on error', async () => {
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

test('checkPromise handles ##EXTERNAL_RESULT## marker: updates --since, returns unmet, does not mark done', async () => {
  const home = tmpHome();
  const file = ledgerFile(home);
  const sessionId = 'test-external-session';
  const checkCmd = 'node tools/auto-progress-external-check.mjs --channel line --thread-id g1 --since 2026-11-12T00:00:00Z';
  writeLedger(file, [{
    ts: new Date(now - 3600000).toISOString(), pc: 'test', user: 'test', sessionId,
    cwd: home, promise: '外部監視テスト', status: 'open',
    check: checkCmd, checkRegisteredAt: new Date(now - 3600000).toISOString(),
    deadlineAt: new Date(now + 86400000).toISOString(), label: '外部監視テスト',
    nextClaude: '新着を報告',
  }]);

  // Simulate check output with ##EXTERNAL_RESULT## marker
  const result = {
    code: 1,
    stdout: '✅ 外部チャネル(line) に新着 2件\n##EXTERNAL_RESULT##' + JSON.stringify({
      channel: 'line', threadId: 'g1', count: 2,
      messages: [
        { id: 'm1', at: '2026-11-12T04:00:00Z', sender: '森田様', text: '案2でお願いします' },
        { id: 'm3', at: '2026-11-12T05:00:00Z', sender: '池永様', text: '回答です' },
      ],
      latestAt: '2026-11-12T05:00:00Z',
    }),
    text: '未達',
  };
  let patched = {};
  const patch = (key, changes) => { patched = { ...patched, ...changes }; if (changes.check) writeLedger(file, readLedger(file).map(r => r.sessionId === sessionId ? { ...r, check: changes.check } : r)); return true; };

  const state = await checkPromise({
    check: checkCmd,
    sessionId,
    lastCheckedAt: new Date().toISOString(),
    status: 'open',
  }, { home, now, patch, io: { executeCheck: () => result }, suppressNotices: true });

  assert.equal(state, 'unmet', 'should continue monitoring as unmet');
  // Check that --since was updated to latestAt
  const rows = readLedger(file);
  const row = rows.find(r => r.sessionId === sessionId);
  assert.ok(row, 'row should exist');
  assert.ok(row.check.includes('--since 2026-11-12T05:00:00Z'), `check should have updated --since: ${row.check}`);
  // Check that the row is NOT marked as done
  assert.equal(row.status, 'open', 'row must remain open for continuous monitoring');
  assert.notEqual(row.status, 'done', 'row must not be marked done');
});