import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './fleet-mail.mjs';
import { scanBroadcastReceipts, withTimeout } from './lib/fleet-poll-budget.mjs';

for (const hanging of ['fetch', 'body']) test(`poll bounds a non-cooperative ${hanging} reader`, async () => {
  let signal;
  const events = [];
  const client = createClient({ url: 'https://example.invalid', token: 'private-token', onAttempt: e => events.push(e),
    fetchImpl: async (_url, opts) => {
      signal = opts.signal;
      if (hanging === 'fetch') return new Promise(() => {});
      return { ok: true, status: 200, json: () => new Promise(() => {}) };
    } });
  await assert.rejects(client('mail-poll', {}, 20), { name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
  assert.equal(events.length, 2);
  assert.equal(events[1].outcome, 'timeout');
  assert.ok(!JSON.stringify(events).includes('private-token'));
});

test('busy retries share the total deadline and cap the final request to remaining time', async () => {
  let clock = 0, count = 0;
  const events = [], sleeps = [];
  const client = createClient({ url: 'https://example.invalid', token: 'secret', now: () => clock,
    onAttempt: e => events.push(e), sleepImpl: async ms => { sleeps.push(ms); clock += ms; },
    fetchImpl: async () => { count++; clock += count === 1 ? 59_000 : 29_500;
      return { ok: false, status: 503, json: async () => ({ ok: false, error: 'busy' }) }; } });
  await assert.rejects(client('mail-poll', {}), { name: 'TimeoutError' });
  assert.equal(count, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(events.filter(e => e.event === 'start').map(e => e.timeoutMs), [60_000, 30_000]);
});

test('request diagnostics count responses and bytes without logging mail bodies', async () => {
  const events = [], response = { ok: true, messages: [{ body: 'private-body' }] };
  const client = createClient({ url: 'https://example.invalid', token: 'secret', onAttempt: e => events.push(e),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => response }) });
  assert.deepEqual(await client('mail-poll', { processedIds: ['mail-a'] }), response);
  assert.equal(events[1].messages, 1);
  assert.equal(events[1].processedIds, 1);
  assert.equal(events[1].responseBytes, Buffer.byteLength(JSON.stringify(response)));
  assert.ok(!JSON.stringify(events).includes('private-body'));
});

test('receipt scan returns saved broadcast IDs when a later disk read stalls', async () => {
  const io = { readdir: async () => ['mail-a.json', 'mail-b.json'],
    readFile: async name => name.endsWith('mail-a.json') ? JSON.stringify({ id: 'mail-a', to: 'all', expiresAt: '2099-01-01' }) : new Promise(() => {}) };
  const result = await scanBroadcastReceipts('unused', { io, budgetMs: 20, now: () => 0 });
  assert.deepEqual(result.ids, ['mail-a']);
  assert.equal(result.partial, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.total, 2);
});

test('receipt scan excludes personal, expired and malformed entries', async () => {
  const values = [JSON.stringify({ id: 'mail-a', to: 'all', expiresAt: '2099-01-01' }),
    JSON.stringify({ id: 'mail-b', to: 'someone', expiresAt: '2099-01-01' }),
    JSON.stringify({ id: 'mail-c', to: 'all', expiresAt: '2000-01-01' }), '{bad'];
  const result = await scanBroadcastReceipts('unused', { io: {
    readdir: async () => ['mail-a.json', 'mail-b.json', 'mail-c.json', 'mail-d.json'],
    readFile: async () => values.shift(),
  } });
  assert.deepEqual(result.ids, ['mail-a']);
  assert.equal(result.partial, false);
  assert.equal(result.scanned, 4);
});

test('deadline releases its timer when the operation completes', async () => {
  assert.equal(await withTimeout(async () => 42, 60000), 42);
});


test('partial receipt scans rotate so later inbox entries and pending sync are not starved', async () => {
  let clock = 0;
  const options = { now: () => clock, budgetMs: 10, io: {
    readdir: async () => ['mail-a.json', 'mail-b.json', 'mail-c.json'],
    readFile: async file => { clock += 10; return JSON.stringify({ id: file.match(/mail-[abc]/)[0], to: 'all', expiresAt: '2099-01-01', pendingServer: ['ack'] }); },
  } };
  const a = await scanBroadcastReceipts('unused', options);
  const b = await scanBroadcastReceipts('unused', { ...options, startAfter: a.nextCursor });
  const c = await scanBroadcastReceipts('unused', { ...options, startAfter: b.nextCursor });
  assert.deepEqual([a.ids, b.ids, c.ids], [['mail-a'], ['mail-b'], ['mail-c']]);
  assert.deepEqual(b.mails[0].pendingServer, ['ack']);
});
