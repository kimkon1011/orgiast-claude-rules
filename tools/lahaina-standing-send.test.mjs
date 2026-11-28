import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TITLE, hash, dailyDir, policyPath, attemptPath } from './lahaina-standing-policy.mjs';
import { formatMessage } from './lahaina-daily-message.mjs';
import { sendStandingDaily } from './lahaina-standing-send.mjs';
import { getItem, listItems } from './reply-queue.mjs';
import { main as checkContext } from './send-context-check.mjs';
import { beeperSend } from './beeper-send.mjs';
import { run } from './lahaina-daily-post.mjs';
import { install } from './install-lahaina-daily-post.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-lahaina-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = dailyDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const entry = { date: '2026-11-20', theme: 'テスト', ask: '写真を1枚' };
  const text = formatMessage(entry), date = entry.date;
  const policy = JSON.parse(fs.readFileSync(new URL('../config/lahaina-standing-approval.json', import.meta.url)));
  policy.approvedBodyHashes = { [date]: hash(text) };
  fs.writeFileSync(policyPath(home), JSON.stringify(policy));
  const calendarPath = path.join(dir, 'calendar.json'), sentPath = path.join(dir, 'sent.jsonl'), quotaPath = path.join(dir, 'quota-wait.json');
  fs.writeFileSync(calendarPath, JSON.stringify([entry]));
  const notices = [], calls = [];
  let sends = 0, sentText;
  const readChats = async () => ({ items: [{ id: 'fixture-chat', title: TITLE }], hasMore: false });
  const readMessages = async () => ({ items: sentText ? [f.readback({ id: 'delivered', isSender: true, senderID: '@kimkon1011:beeper.com', text: sentText, timestamp: new Date().toISOString(), chatID: 'fixture-chat' })] : [] });
  const f = { home, dir, date, text, calendarPath, sentPath, quotaPath, policy, now: new Date(`${date}T00:00:00Z`), readChats, readMessages,
    inbox: async (_, notice) => { notices.push(notice); return { id: 'notice' }; }, notices, calls, log: () => {},
    sends: () => sends, readback: message => message,
    transport: { preSendCheck: async () => ({ ok: true, findings: [] }), readChats, readMessages, readMessage: async () => null, clock: () => f.now, sleep: async () => {}, readbackMs: 10,
      // 整合性APIは専用統合テストで検証。この経路テストでは外部取得をモックする。
      consistencyCheck: async () => ({ ok: true, input: { scheduledSends: [] } }),
      send: async (_, body) => { sends++; sentText = body; return { pendingMessageID: 'pending', chatID: 'fixture-chat' }; } },
  };
  f.exec = async (_, args) => {
    calls.push(path.basename(args[0]));
    const val = flag => args[args.indexOf(flag) + 1];
    if (args[0].endsWith('send-context-check.mjs')) {
      const code = await checkContext(args.slice(1), { home, preSendCheck: async () => ({ ok: true, findings: [] }), fetchHistory: async () => ({ target: 'fixture-chat', messages: [] }), runLlm: () => ({ ok: true, reason: 'mock context OK' }) });
      if (code) throw new Error('context denied');
      return '{}';
    }
    assert.equal(path.basename(args[0]), 'beeper-send.mjs');
    return JSON.stringify(await beeperSend({ home, chatID: val('--chat'), bodyFile: val('--body-file'), queueID: val('--queue-id'), receiptID: val('--receipt') }, f.transport));
  };
  return f;
}

test('standing approval uses real decision, context marker, receipt, rate limit, readback and sent ledger; no asks', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.quotaPath, JSON.stringify({ until: '2026-12-01' }));
  const fallback = opts => sendStandingDaily({ ...f, ...opts });
  await run({ ...f, fallback, sender: () => assert.fail('quota must bypass bot') });
  assert.equal(f.sends(), 1);
  const item = listItems(f.home)[0];
  assert.equal(item.state, 'sent');
  assert.equal(JSON.parse(item.decision.reason).approvedBy, 'kim');
  assert.deepEqual(JSON.parse(item.decision.reason).quotes, f.policy.quotes);
  assert.ok(item.receipt.id.startsWith('rc-'));
  assert.equal(item.sent.receiptId, item.receipt.id);
  assert.deepEqual(f.calls, ['send-context-check.mjs', 'beeper-send.mjs']);
  assert.equal(JSON.parse(fs.readFileSync(f.sentPath, 'utf8')).route, 'beeper');
  assert.ok(fs.existsSync(attemptPath(f.home, f.date)));
  assert.ok(fs.existsSync(path.join(f.home, '.claude/reply-queue/beeper-send-log.jsonl')));
  assert.deepEqual(f.notices, []);
  await run({ ...f, fallback, sender: () => assert.fail('must not resend') });
  assert.equal(f.sends(), 1);
  assert.deepEqual(f.notices, [], 'an already delivered daily post is not a send failure');
});

test('HTML readback records message ID/time in the ledger without a failure info and never resends', async t => {
  const f = fixture(t);
  let deliveredAt;
  f.readback = message => {
    deliveredAt = message.timestamp;
    return { ...message, mentions: null, text: '<p>' + message.text.replace(/\n\n/g, '</p>\n<p>').replace(/(?<!>)\n/g, '<br>') + '</p>' };
  };
  fs.writeFileSync(f.quotaPath, JSON.stringify({ until: '2026-12-01' }));
  const fallback = opts => sendStandingDaily({ ...f, ...opts });
  await run({ ...f, fallback, sender: () => assert.fail('must not use bot') });
  const row = JSON.parse(fs.readFileSync(f.sentPath, 'utf8'));
  assert.equal(row.messageID, 'delivered');
  assert.equal(row.sentAt, deliveredAt);
  assert.equal(row.chatID, 'fixture-chat');
  assert.equal(listItems(f.home)[0].state, 'sent');
  const attempt = fs.readFileSync(attemptPath(f.home, f.date), 'utf8');
  await run({ ...f, fallback, sender: () => assert.fail('must not resend') });
  assert.equal(f.sends(), 1);
  assert.equal(fs.readFileSync(attemptPath(f.home, f.date), 'utf8'), attempt);
  assert.deepEqual(f.notices, []);
});

for (const [label, mutate] of [
  ['different body', m => ({ ...m, text: m.text + '追加' })],
  ['other sender', m => ({ ...m, isSender: false, senderID: '@other:beeper.com' })],
  ['wrong senderID despite isSender', m => ({ ...m, senderID: '@other:beeper.com' })],
  ['old timestamp', m => ({ ...m, timestamp: '2026-11-01T00:00:00Z' })],
  ['future timestamp', m => ({ ...m, timestamp: '2099-01-01T00:00:00Z' })],
  ['additional mention', m => ({ ...m, mentions: ['@other:beeper.com'] })],
]) test(`readback rejects ${label}, leaves uncertain and cannot resend`, async t => {
  const f = fixture(t); f.readback = mutate;
  const r = await sendStandingDaily(f);
  assert.equal(r.state, 'blocked');
  assert.equal(getItem(f.home, r.queueID).state, 'uncertain');
  assert.equal(fs.existsSync(f.sentPath), false);
  await sendStandingDaily(f);
  await run({ ...f, sender: () => assert.fail('must not retry via bot') });
  assert.equal(f.sends(), 1);
  assert.ok(fs.existsSync(attemptPath(f.home, f.date)));
});

for (const [label, mutate] of [
  ['late evening JST', f => { f.now = new Date(`${f.date}T23:59:59+09:00`); }],
  ['08:59:59 JST', f => { f.now = new Date(`${f.date}T08:59:59+09:00`); }],
  ['11:30:01 JST', f => { f.now = new Date(`${f.date}T11:30:01+09:00`); }],
  ['stale date', f => { f.date = '2026-11-19'; }],
  ['modified body', f => { f.text += '追加'; }],
  ['modified calendar and body', f => { const entries = JSON.parse(fs.readFileSync(f.calendarPath)); entries[0].ask = '変更'; fs.writeFileSync(f.calendarPath, JSON.stringify(entries)); f.text = formatMessage(entries[0]); }],
  ['wrong title', f => { f.title = '他のグループ'; }],
  ['no exact chat', f => { f.readChats = async () => ({ items: [{ id: 'wrong', title: TITLE + '2' }] }); }],
  ['ambiguous chats', f => { f.readChats = async () => ({ items: [{ id: 'a', title: TITLE }, { id: 'b', title: TITLE }] }); }],
  ['sent ledger', f => { fs.writeFileSync(f.sentPath, JSON.stringify({ date: f.date }) + '\n'); }],
  ['unreadable ledger', f => { fs.writeFileSync(f.sentPath, '{broken'); }],
  ['crashed prior attempt', f => { fs.writeFileSync(attemptPath(f.home, f.date), '{}'); }],
  ['revoked policy', f => { f.policy.enabled = false; fs.writeFileSync(policyPath(f.home), JSON.stringify(f.policy)); }],
  ['expanded policy', f => { f.policy.scope.maxPerDay = 2; fs.writeFileSync(policyPath(f.home), JSON.stringify(f.policy)); }],
  ['missing policy', f => { fs.unlinkSync(policyPath(f.home)); }],
]) test(`scope blocks ${label} with info only`, async t => {
  const f = fixture(t); mutate(f);
  const r = await sendStandingDaily(f);
  assert.equal(r.state, 'blocked'); assert.equal(f.sends(), 0); assert.deepEqual(f.calls, []);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].kind, 'info');
});

test('11:30:00 JST remains in scope', async t => {
  const f = fixture(t); f.now = new Date(`${f.date}T11:30:00+09:00`);
  assert.equal((await sendStandingDaily(f)).state, 'sent'); assert.equal(f.sends(), 1);
});

test('dry-run is read-only, even when blocked', async t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.dir);
  assert.equal((await sendStandingDaily({ ...f, dryRun: true })).eligible, true);
  assert.equal((await sendStandingDaily({ ...f, text: 'changed', dryRun: true })).eligible, false);
  assert.deepEqual(fs.readdirSync(f.dir), before); assert.equal(f.notices.length, 0); assert.equal(f.sends(), 0);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/reply-queue')), false);
});

test('uncertain send is not retried, including after quota expires or sent.jsonl was never written', async t => {
  const f = fixture(t);
  let dispatches = 0;
  f.transport.send = async () => { dispatches++; throw new Error('timeout after dispatch'); };
  const r = await sendStandingDaily(f);
  assert.equal(r.state, 'blocked'); assert.equal(getItem(f.home, r.queueID).state, 'uncertain');
  await sendStandingDaily(f);
  await run({ ...f, sender: () => assert.fail('must not switch to bot after uncertain delivery') });
  assert.equal(dispatches, 1); assert.ok(f.notices.every(n => n.kind === 'info'));
});

test('history failure prevents receipt and transport', async t => {
  const f = fixture(t);
  f.exec = () => { throw new Error('history unavailable'); };
  const r = await sendStandingDaily(f);
  assert.equal(r.state, 'blocked'); assert.equal(getItem(f.home, r.queueID).receipt, undefined); assert.equal(f.sends(), 0);
});

test('new incoming message invalidates approval and cannot be automatically reapproved', async t => {
  const f = fixture(t);
  f.readMessages = async () => ({ items: [{ id: 'new', text: 'new context', isSender: false, timestamp: '2030-01-01T00:00:00Z' }] });
  const r = await sendStandingDaily(f);
  assert.equal(getItem(f.home, r.queueID).state, 'queued');
  await sendStandingDaily({ ...f, readMessages: async () => ({ items: [] }) });
  assert.equal(f.sends(), 0); assert.equal(f.calls.length, 1);
});

test('rate limit blocks standing approval', async t => {
  const f = fixture(t);
  const log = path.join(f.home, '.claude/reply-queue/beeper-send-log.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, Array.from({ length: 3 }, () => JSON.stringify({ ts: new Date().toISOString(), chatID: 'fixture-chat' })).join('\n'));
  assert.equal((await sendStandingDaily(f)).state, 'blocked'); assert.equal(f.sends(), 0);
});

for (const change of ['time', 'title', 'policy', 'body', 'whitespace']) test(`scope is rechecked at dispatch after ${change} changes`, async t => {
  const f = fixture(t);
  const original = f.exec;
  f.exec = async (node, args) => {
    if (args[0].endsWith('beeper-send.mjs')) {
      if (change === 'time') f.now = new Date(`${f.date}T11:31:00+09:00`);
      if (change === 'title') f.transport.readChats = async () => ({ items: [{ id: 'different-chat', title: TITLE }] });
      if (change === 'policy') { f.policy.enabled = false; fs.writeFileSync(policyPath(f.home), JSON.stringify(f.policy)); }
      if (change === 'body') fs.appendFileSync(args[args.indexOf('--body-file') + 1], 'tampered');
      if (change === 'whitespace') fs.appendFileSync(args[args.indexOf('--body-file') + 1], '\n');
    }
    return original(node, args);
  };
  assert.equal((await sendStandingDaily(f)).state, 'blocked'); assert.equal(f.sends(), 0);
});

test('parallel invocations send at most once and never ask', async t => {
  const f = fixture(t);
  await Promise.all([sendStandingDaily(f), sendStandingDaily(f)]);
  assert.equal(f.sends(), 1); assert.ok(f.notices.every(n => n.kind === 'info'));
});

test('readback does not mistake a previous day with the same prefix for this delivery', async t => {
  const f = fixture(t);
  f.transport.send = async () => ({ pendingMessageID: 'pending', chatID: 'fixture-chat' });
  f.transport.readMessages = async () => ({ items: [{ id: 'old', isSender: true, timestamp: '2026-11-01T00:00:00Z', text: f.text }] });
  f.transport.readMessage = async () => ({ id: 'old', isSender: true, timestamp: '2026-11-01T00:00:00Z', text: f.text });
  const r = await sendStandingDaily(f);
  assert.equal(r.state, 'blocked'); assert.equal(getItem(f.home, r.queueID).state, 'uncertain');
});

test('installer pins runtime helpers and preserves revocation/calendar/task files', async t => {
  const f = fixture(t);
  const entry = path.join(f.dir, 'send-today.mjs');
  fs.writeFileSync(entry, '// original entry\n');
  f.policy.enabled = false; fs.writeFileSync(policyPath(f.home), JSON.stringify(f.policy));
  const beforeCalendar = fs.readFileSync(f.calendarPath, 'utf8'), beforePolicy = fs.readFileSync(policyPath(f.home), 'utf8');
  const sourceRepo = path.resolve('.');
  install({ home: f.home, sourceRepo, dependencyRepo: sourceRepo });
  assert.equal(fs.readFileSync(f.calendarPath, 'utf8'), beforeCalendar);
  assert.equal(fs.readFileSync(policyPath(f.home), 'utf8'), beforePolicy);
  const helper = fs.readFileSync(path.join(f.dir, 'runtime/daily-beeper-approval.mjs'), 'utf8');
  assert.match(helper, /new URL\('\.\/beeper-send.mjs', import.meta.url\)/);
  const installed = await import(pathToFileURL(path.join(f.dir, 'runtime/lahaina-standing-send.mjs')));
  assert.equal((await installed.sendStandingDaily({ ...f, dryRun: true })).eligible, false);
  fs.unlinkSync(policyPath(f.home));
  install({ home: f.home, sourceRepo, dependencyRepo: sourceRepo });
  assert.deepEqual(JSON.parse(fs.readFileSync(policyPath(f.home))), JSON.parse(fs.readFileSync('config/lahaina-standing-approval.json')));
  assert.equal(fs.readFileSync(entry + '.before-free-route', 'utf8'), '// original entry\n');
});
