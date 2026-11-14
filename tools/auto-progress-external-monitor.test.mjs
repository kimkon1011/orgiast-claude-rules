import test from 'node:test';
process.env.ORGIAST_AUTO_RESUME = '1';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pollExternal, drainExternalQueue, repairExternalInboxReceipts } from './auto-progress-external-monitor.mjs';
import { externalSpec, readEvents, saveEvent, MONITOR_DAYS, notifiedGmailIds, recentSessionSends, gmailNotificationOwned } from './lib/external-monitor-state.mjs';
import { record, readLedger, ledgerFile, writeLedger, rowKey } from './auto-progress-ledger.mjs';
import { recordOutbound } from './lib/send-context.mjs';
import { addCheck } from './auto-progress.mjs';
import { fetchGmailMessages, fetchLineMessages } from './auto-progress-external-check.mjs';
import { run } from './auto-progress-watch.mjs';
import { notificationMocks } from './test-helpers/auto-progress-home.mjs';
import { addItem, listItems, answerItem, updateInboxItem } from './kim-inbox.mjs';

const now = Date.parse('2026-11-12T06:00:00Z');
const baseRow = () => ({ ts: new Date(now).toISOString(), sessionId: 'origin-session', pc: 'pc', user: 'user', status: 'open', cwd: process.cwd(),
  check: 'node tools/auto-progress-external-check.mjs --channel line --thread-id group1 --since 2026-11-12T04:34:01Z', label: '返信待ち' });
const message = (id, at = '2026-11-12T05:00:00Z') => ({ id, at, sender: '担当者', text: 'あ'.repeat(240) });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'external-monitor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('real inbox keeps different message hashes distinct even after the first is answered', async t => {
  const home = fixture(t), row = baseRow();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  const opts = { home, now, patch: (_, c) => Object.assign(row, c), io: {
    fetchExternalMessages: async () => [message('first')],
    addKimInboxItem: addItem,
  } };
  await pollExternal(row, opts);
  answerItem(home, listItems(home)[0].id, '確認済み');
  opts.io.fetchExternalMessages = async () => [message('second')];
  await pollExternal(row, opts);
  await pollExternal(row, opts);
  const events = readEvents(home), items = listItems(home);
  assert.equal(items.length, 2);
  assert.equal(new Set(events.map(e => e.inboxId)).size, 2);
  assert.equal(items.filter(i => i.status === 'open' && i.text.startsWith('🔴')).length, 1);
});

test('repair requeues lost receipts beyond the cursor once, preserving genuine answered notices', async t => {
  const home = fixture(t), row = baseRow();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
  const opts = { home, now, patch: (_, c) => Object.assign(row, c), io: {
    fetchExternalMessages: async () => [message('first')],
  } };
  await pollExternal(row, opts);
  const first = listItems(home)[0];
  answerItem(home, first.id, '確認済み');
  updateInboxItem(home, first.id, item => { item.dedupeKey = 'external-message:[REDACTED]'; });
  // Reproduce the old addItem collision, including identical visible text.
  opts.io.fetchExternalMessages = async () => [message('second')];
  opts.io.addKimInboxItem = async () => first;
  opts.now++;
  await pollExternal(row, opts);
  for (const event of readEvents(home)) {
    event.state = 'done'; event.attemptedAt = new Date(now).toISOString();
    event.resumeOutcome = { state: 'needs_user' }; saveEvent(home, event);
  }
  const cursor = row.check;
  // Failed delivery must leave the old receipt recoverable.
  await assert.rejects(repairExternalInboxReceipts({ home, now, io: {
    addKimInboxItem: async () => ({ id: 'failed', forwardError: 'offline' }),
  } }), /offline/);
  assert.ok(readEvents(home).every(e => e.inboxId === first.id));
  const result = await repairExternalInboxReceipts({ home, now });
  assert.equal(result.requeued, 1);
  assert.equal(row.check, cursor);
  assert.equal(listItems(home).length, 2);
  assert.equal(listItems(home).find(i => i.id === first.id).status, 'answered');
  const repaired = readEvents(home).find(e => e.message.id === 'second');
  assert.equal(repaired.state, 'pending');
  assert.equal(repaired.attemptedAt, undefined);
  assert.equal(repaired.row.sessionId, row.sessionId);
  assert.equal(repaired.inboxRepair.previousState, 'done');
  assert.deepEqual(await repairExternalInboxReceipts({ home, now }), { rekeyed: 0, requeued: 0 });
  let resumes = 0;
  const resume = async queued => {
    resumes++; assert.equal(queued.sessionId, row.sessionId);
    assert.match(queued.nextClaude, /second/); assert.doesNotMatch(queued.nextClaude, /first/);
    return { state: 'needs_user' };
  };
  await drainExternalQueue({ home, now, resume });
  await drainExternalQueue({ home, now: now + 3600000, resume });
  assert.equal(resumes, 1);
  assert.equal(listItems(home).length, 2);
});
test('repeated arrivals keep check open; equal timestamp messages dedupe by ID and queue original session', async t => {
  const home = fixture(t), row = baseRow(), notices = new Map();
  let messages = [message('m1')];
  const opts = { home, now, patch: (_, changes) => Object.assign(row, changes), io: {
    fetchExternalMessages: async spec => { assert.ok(spec.since); return messages; },
    addKimInboxItem: async (_, item) => { notices.set(item.dedupeKey, item); return { id: item.dedupeKey }; },
  } };
  await pollExternal(row, opts);
  assert.equal(row.status, 'open');
  assert.equal(Date.parse(row.deadlineAt), now + MONITOR_DAYS);
  assert.match(row.check, /--since 2026-11-12T05:00:00Z/);
  messages = [message('m1'), message('m2')];
  await pollExternal(row, opts);
  await pollExternal(row, opts);
  assert.equal(notices.size, 2);
  assert.equal(readEvents(home).length, 2);
  const notice = [...notices.values()][0];
  assert.equal(notice.kind, 'ask');
  assert.match(notice.text, /🔴.*\n送信者: 担当者\n時刻:/);
  assert.ok(notice.text.includes('あ'.repeat(200)));
  assert.ok(!notice.text.includes('あ'.repeat(201)));
  let calls = 0;
  const resume = async (queued, options) => {
    calls++; assert.equal(queued.sessionId, row.sessionId); assert.equal(options.reason, 'external-message');
    assert.match(queued.nextClaude, /社外送信は行わない/); return { state: 'progressed' };
  };
  await drainExternalQueue({ home, now, resume });
  await drainExternalQueue({ home, now: now + 3600000, resume });
  assert.equal(calls, 1);
  assert.equal(row.status, 'open');
});
test('delivery failure retains cursor and retries with durable message dedupe key', async t => {
  const home = fixture(t), row = baseRow();
  let failed = true;
  const keys = [], opts = { home, now, patch: (_, c) => Object.assign(row, c), io: {
    fetchExternalMessages: async () => [message('m1')],
    addKimInboxItem: async (_, item) => {
      if (item.source.endsWith('-error')) return { id: 'error' };
      keys.push(item.dedupeKey);
      return failed ? { id: 'inbox', forwardError: 'offline' } : { id: 'inbox' };
    },
  } };
  assert.equal(await pollExternal(row, opts), 'error');
  assert.equal(externalSpec(row).since, '2026-11-12T04:34:01Z');
  assert.ok(!readEvents(home)[0].inboxId);
  failed = false;
  await pollExternal(row, opts);
  assert.equal(keys[0], keys[1]);
  assert.equal(readEvents(home)[0].inboxId, 'inbox');
});
test('ledger write crash after delivery does not duplicate inbox or queue', async t => {
  const home = fixture(t), row = baseRow(); let calls = 0, crash = true;
  const opts = { home, now, patch: (_, changes) => {
    if (changes.check && crash) throw new Error('disk failed');
    Object.assign(row, changes);
  }, io: { fetchExternalMessages: async () => [message('m1')], addKimInboxItem: async (_, item) => {
    if (item.source === 'auto-progress-external') calls++; return { id: 'inbox' };
  } } };
  await pollExternal(row, opts);
  crash = false;
  await pollExternal(row, opts);
  assert.equal(calls, 1); assert.equal(readEvents(home).length, 1);
});
test('expiry never fetches or resumes and empty/error polls remain open', async t => {
  const home = fixture(t), row = baseRow();
  const opts = { home, now, patch: (_, c) => Object.assign(row, c), io: { fetchExternalMessages: async () => [], addKimInboxItem: async () => ({ id: 'error' }) } };
  await pollExternal(row, opts); assert.equal(row.status, 'open');
  opts.io.fetchExternalMessages = async () => { throw new Error('network'); };
  await pollExternal(row, opts); assert.equal(row.status, 'open'); assert.equal(row.externalError, 'network');
  opts.now = Date.parse(row.deadlineAt);
  opts.io.fetchExternalMessages = () => assert.fail('expired');
  assert.equal(await pollExternal(row, opts), 'expired'); assert.equal(row.status, 'expired');
});
test('resume failures preserve queue, notify, and retry next interval', async t => {
  const home = fixture(t), row = baseRow();
  const io = { fetchExternalMessages: async () => [message('m1')], addKimInboxItem: async () => ({ id: 'inbox' }) };
  await pollExternal(row, { home, now, patch: (_, c) => Object.assign(row, c), io });
  let calls = 0;
  const resume = async () => { calls++; throw new Error('timeout'); };
  await drainExternalQueue({ home, now, resume, io });
  await drainExternalQueue({ home, now, resume, io });
  assert.equal(calls, 1); assert.equal(readEvents(home)[0].state, 'pending');
  await drainExternalQueue({ home, now: now + 30 * 60000, resume, io });
  assert.equal(calls, 2);
});
test('Gmail read only thread fetch excludes sent/drafts and returns sender/time/body', async () => {
  const messages = await fetchGmailMessages('thread', '2026-11-12T04:00:00Z', {
    getToken: async args => { assert.match(args.scope, /readonly$/); assert.equal(args.impersonate, 'a@orgiast.jp'); return 'test'; }, mailbox: 'a@orgiast.jp',
    fetchImpl: async (url, opts) => { assert.match(url, /threads\/thread\?format=full/); assert.ok(!opts.method); return { ok: true, json: async () => ({ messages: [
      { id: 'new', internalDate: String(now), payload: { headers: [{ name: 'From', value: '相手 <client@example.com>' }] }, snippet: '返信' },
      { id: 'sent', internalDate: String(now), labelIds: ['SENT'] },
      { id: 'draft', internalDate: String(now), labelIds: ['DRAFT'] },
      { id: 'old', internalDate: '1' },
    ] }) }; },
  });
  assert.deepEqual(messages.map(m => m.id), ['new']); assert.equal(messages[0].text, '返信');
});
test('LINE paginates beyond API limit and preserves equal timestamp boundary', async () => {
  let calls = 0;
  const result = await fetchLineMessages({ SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'test' }, 'g', '2026-11-12T00:00:00Z', {
    inclusive: true, fetchImpl: async url => {
      assert.match(url, /created_at=gte\./); assert.match(url, new RegExp(`offset=${calls * 500}`)); calls++;
      return { ok: true, json: async () => Array.from({ length: calls === 1 ? 500 : 1 }, (_, i) => ({ id: `${calls}-${i}`, created_at: '2026-11-12T01:00:00Z' })) };
    },
  });
  assert.equal(result.length, 501); assert.equal(calls, 2);
});
test('Stop hook registers only successful sends from current turn, keeps cursor and separates destinations', t => {
  const home = fixture(t), transcript = path.join(home, 'session.jsonl');
  const entries = [{ type: 'user', message: { content: '依頼' } }];
  for (const [id, command, channel, target] of [
    ['l1', 'node tools/line-group-send.mjs --group group --text-file text', 'line', 'group'],
    ['g1', 'node tools/gmail-draft.mjs --send draft --user a@orgiast.jp --json', 'gmail', 'thread'],
    ['fail', 'node tools/gmail-draft.mjs --send bad', 'gmail', 'bad'],
  ]) {
    recordOutbound({ channel, target, messageId: id, at: new Date(now - 1000).toISOString() }, home);
    entries.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, input: { command } }] } });
    entries.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: id === 'fail', content: id }] } });
  }
  recordOutbound({ channel: 'line', target: 'another-session', messageId: 'other', at: new Date(now).toISOString() }, home);
  fs.writeFileSync(transcript, entries.map(e => JSON.stringify(e)).join('\n'));
  const input = { session_id: 'session', transcript_path: transcript, cwd: process.cwd(), last_assistant_message: 'この後の自動進行: 返信待ち。返事を確認します' };
  addCheck({ home, now: now - 5000, session: 'session', label: '別の確認', check: 'node other.mjs', deadline: '+1d' });
  record(input, { home, now, owner: 'owner' });
  record(input, { home, now: now + 1, owner: 'owner' });
  const monitors = readLedger(ledgerFile(home)).filter(r => r.status === 'open' && externalSpec(r));
  assert.equal(monitors.length, 2);
  assert.equal(externalSpec(monitors.find(r => r.check.includes('gmail'))).mailbox, 'a@orgiast.jp');
  assert.ok(monitors.every(r => Date.parse(r.deadlineAt) === now + MONITOR_DAYS));
  assert.equal(new Set(monitors.map(rowKey)).size, 2);
  assert.equal(readLedger(ledgerFile(home)).find(r => r.label === '別の確認').status, 'open');
  entries.push({ type: 'user', message: { content: '次の別件' } });
  fs.writeFileSync(transcript, entries.map(e => JSON.stringify(e)).join('\n'));
  assert.deepEqual(recentSessionSends(transcript, home, now + 2), []);
});
test('external add-check defaults to fourteen days and never converts next action to one-shot start', t => {
  const home = fixture(t);
  writeLedger(ledgerFile(home), [{ ...baseRow(), sessionId: 'session', check: undefined, promise: '古い送信約束を実行する' }]);
  const row = addCheck({ home, now, session: 'session', label: 'monitor', check: baseRow().check, nextClaude: '履歴を確認', probe: () => ({ code: 0 }) });
  assert.equal(row.status, 'open'); assert.ok(!row.startWhen); assert.equal(Date.parse(row.deadlineAt), now + MONITOR_DAYS);
});
test('empty polls do not widen the initial baseline and include equal timestamps only after arrival', async t => {
  const home = fixture(t), row = baseRow(), inclusive = [];
  let messages = [];
  const opts = { home, now, patch: (_, c) => Object.assign(row, c), io: {
    fetchExternalMessages: async spec => { inclusive.push(spec.inclusive); return messages; },
    addKimInboxItem: async () => ({ id: 'inbox' }),
  } };
  await pollExternal(row, opts); await pollExternal(row, opts);
  messages = [message('m1')]; await pollExternal(row, opts); await pollExternal(row, opts);
  assert.deepEqual(inclusive, [false, false, false, true]);
});
test('external-waiting delegates active Gmail threads even before first poll, preserving drafts and other mail', t => {
  const home = fixture(t), row = baseRow();
  row.check = row.check.replace('--channel line', '--channel gmail');
  row.deadlineAt = new Date(now + MONITOR_DAYS).toISOString();
  writeLedger(ledgerFile(home), [row]);
  const item = { kind: 'reply', mailbox: 'seisaku-team@orgiast.jp', threadId: 'group1', lastMessageId: 'm1', since: new Date(now).toISOString() };
  assert.ok(gmailNotificationOwned(home, now)(item));
  assert.ok(!gmailNotificationOwned(home, now)({ ...item, threadId: 'other' }));
  assert.ok(!gmailNotificationOwned(home, now)({ ...item, kind: 'draft' }));
  assert.ok(!gmailNotificationOwned(home, now + MONITOR_DAYS)(item));
});
test('watch integration polls and drains external queue without completing monitor or running shell check', async t => {
  const home = fixture(t);
  addCheck({ home, now, session: 'session', label: 'monitor', check: baseRow().check });
  let resumes = 0;
  const result = await run({ home, now, io: { ...notificationMocks, clock: () => now, transcriptFiles: [], sheetConfig: () => null,
    digest: async () => ({}), escalateKimDecisions: async () => ({}),
    executeCheck: () => assert.fail('external checks must not use one-shot shell lane'),
    fetchExternalMessages: async () => [message('m1')], addKimInboxItem: async () => ({ id: 'inbox' }),
    resume: async row => { resumes++; assert.equal(row.sessionId, 'session'); return { state: 'progressed' }; },
  } });
  assert.equal(result.done, 0); assert.equal(resumes, 1);
  assert.equal(readLedger(ledgerFile(home))[0].status, 'open');
});
test('Gmail notified message IDs shared with external-waiting', async t => {
  const home = fixture(t), row = baseRow(); row.check = row.check.replace('--channel line', '--channel gmail');
  await pollExternal(row, { home, now, patch: (_, c) => Object.assign(row, c), io: {
    fetchExternalMessages: async () => [message('m1')], addKimInboxItem: async () => ({ id: 'inbox' }),
  } });
  assert.ok(notifiedGmailIds(home).has('seisaku-team@orgiast.jp|m1'));
  assert.ok(!notifiedGmailIds(home).has('seisaku-team@orgiast.jp|m2'));
});
