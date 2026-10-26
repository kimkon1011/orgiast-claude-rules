import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, formatAlert, CHANNEL, markLaneHealthSeen } from './fleet-mail-watchdog.mjs';
import { KIM_USER_ID, notifyArrival, postToChannel } from './lib/fleet-mail-discord.mjs';
import { createClient, CAPABILITY_BACKOFF_MS } from './fleet-mail.mjs';
function fixture(t, alerts = [{ id: 'mail-one', to: 'kim-PC', from: 'PC', kind: 'unseen', why: '確認', notifiedCount: 0 }]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watch-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid\nFLEET_SHEET_TOKEN=test\n');
  const calls = [], posts = [], dms = [], outputs = [];
  const deps = { home, token: 'test', stdout: x => outputs.push(x), stderr() {}, request: async (kind, payload) => { calls.push({ kind, payload }); return { ok: true, alerts: payload.notifiedIds ? [] : alerts }; }, postChannel: async (...args) => posts.push(args), notifyKim: async (...args) => { dms.push(args); return { delivered: 'dm' }; } };
  return { home, calls, posts, dms, outputs, deps };
}
test('watchdog reads alerts and confirms only after channel/DM delivery', async t => {
  const f = fixture(t); await main([], f.deps);
  assert.deepEqual(f.calls, [{ kind: 'mail-alerts', payload: {} }, { kind: 'mail-alerts', payload: { notifiedIds: ['mail-one'] } }]);
  assert.equal(f.posts[0][1], CHANNEL); assert.equal(f.dms[0][1].userId, KIM_USER_ID); assert.equal(f.dms[0][1].webhookFallback, false);
});
test('server webhook delivered alerts are not duplicated', async t => {
  const f = fixture(t, [{ id: 'mail-one', notifiedCount: 1 }]); await main([], f.deps);
  assert.equal(f.posts.length, 0); assert.equal(f.dms.length, 0); assert.equal(f.calls.length, 1);
});
test('failed routes including delivered:none leave alerts pending', async t => {
  const f = fixture(t); await main([], { ...f.deps, postChannel: async () => { throw new Error('offline'); }, notifyKim: async () => ({ delivered: 'none' }) });
  assert.equal(f.calls.length, 1);
});
test('successful DM alone confirms delivery', async t => {
  const f = fixture(t); await main([], { ...f.deps, token: '' }); assert.equal(f.posts.length, 0); assert.equal(f.calls.length, 2);
});
test('successful channel alone confirms delivery', async t => {
  const f = fixture(t); await main([], { ...f.deps, notifyKim: async () => { throw new Error('offline'); } }); assert.equal(f.calls.length, 2);
});
test('dry run reads only and logs counts without contents', async t => {
  const f = fixture(t); await main(['--dry-run', '--json'], f.deps); assert.equal(f.calls.length, 1); assert.equal(f.posts.length, 0); assert.equal(f.dms.length, 0); assert.equal(JSON.parse(f.outputs[0]).pending, 1); assert.doesNotMatch(f.outputs[0], /mail-one|確認/);
});
test('unconfigured watchdog does no requests', async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.home, '.claude', 'fleet-sheet.env')); await main([], f.deps); assert.equal(f.calls.length, 0);
});
test('alert formatting masks secrets and distinguishes undelivered from unseen', () => {
  assert.match(formatAlert({ kind: 'unseen' }), /読まれていません/); assert.match(formatAlert({ kind: 'undelivered' }), /届いていません/);
  assert.doesNotMatch(formatAlert({ why: 'token=private' }), /private/);
});
test('client accepts alerts shape and rejects old GAS fallback', async () => {
  const client = result => createClient({ url: 'https://example.invalid', token: 'test', fetchImpl: async () => ({ ok: true, json: async () => result }) });
  assert.deepEqual(await client({ ok: true, alerts: [] })('mail-alerts', {}), { ok: true, alerts: [] });
  await assert.rejects(client({ ok: true, mail: null })('mail-alerts', {}), /not deployed/);
});
test('shared Discord transport disables mentions and masks content', async () => {
  const calls = []; await postToChannel('test', CHANNEL, 'token=private @everyone', async (...args) => { calls.push(args); return { ok: true }; });
  const body = JSON.parse(calls[0][1].body); assert.deepEqual(body.allowed_mentions, { parse: [] }); assert.doesNotMatch(body.content, /private/);
});
test('arrival uses one line, recipient, category, clipped reason and id', async t => {
  const f = fixture(t); const calls = [];
  assert.equal(await notifyArrival({ id: 'mail-one', why: '[作業依頼] '+ 'あ'.repeat(100) }, { home: f.home, label: 'receiver', token: 'test', fetchImpl: async (...args) => { calls.push(args); return { ok: true }; } }), true);
  const content = JSON.parse(calls[0][1].body).content;
  assert.match(content, /^receiver 宛 \[作業依頼\] 到着:/); assert.ok(content.endsWith(' / mail-one [fleet-arrival]')); assert.ok(content.split('到着: ')[1].split(' / ')[0].length <= 60); assert.doesNotMatch(content, /\n/);
});
test('missing arrival route skips without a network request', async t => {
  const f = fixture(t); const errors = [];
  assert.equal(await notifyArrival({ id: 'mail-one', priority: 'urgent' }, { home: f.home, token: '', stderr: x => errors.push(x), fetchImpl: async () => assert.fail('network') }), false); assert.equal(errors.length, 1);
});

test('C6 old GAS mail-alerts response is cached and suppressed during the capability backoff', async t => {
  const f = fixture(t); let now = Date.now(), requests = 0;
  f.deps.now = () => now;
  f.deps.request = async () => { requests++; return { ok: true, action: 'updated', row: 2 }; };
  assert.equal(await main([], f.deps), 0); assert.equal(await main([], f.deps), 0); assert.equal(requests, 1);
  const state = JSON.parse(fs.readFileSync(path.join(f.home, '.claude', '.fleet-mail-last-poll.json'), 'utf8'));
  assert.equal(state.serverCapabilities.seen, false); assert.equal(state.serverCapabilities.alerts, false);
  now += CAPABILITY_BACKOFF_MS; assert.equal(await main([], f.deps), 0); assert.equal(requests, 2);
  assert.equal(f.posts.length, 0); assert.equal(f.dms.length, 0);
});

test('C6 capability probes do not refresh Task B last-successful-poll health timestamps', async t => {
  const f = fixture(t), file = path.join(f.home, '.claude', '.fleet-mail-last-poll.json');
  const old = new Date(Date.now() - 2 * CAPABILITY_BACKOFF_MS);
  fs.writeFileSync(file, JSON.stringify({ at: old.toISOString() })); fs.utimesSync(file, old, old);
  const mtime = fs.statSync(file).mtimeMs;
  f.deps.request = async () => ({ ok: true, action: 'updated', row: 2 });
  await main([], f.deps); assert.ok(Math.abs(fs.statSync(file).mtimeMs - mtime) < 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).at, old.toISOString());
});

for (const mode of ['throw', 'negative']) test(`D7 watchdog isolates ${mode} acknowledgement failure and continues`, async t => {
  const f = fixture(t, ['mail-one', 'mail-two'].map(id => ({ id, kind: 'unseen' })));
  const errors = [], request = f.deps.request;
  f.deps.stderr = text => errors.push(text);
  f.deps.request = async (kind, payload) => {
    const result = await request(kind, payload);
    if (payload.notifiedIds?.[0] === 'mail-one') {
      if (mode === 'throw') throw new Error('token=private');
      return { ok: false };
    }
    return result;
  };
  await main(['--json'], f.deps);
  assert.equal(f.posts.length, 2); assert.equal(f.dms.length, 2);
  assert.deepEqual(f.calls.at(-1).payload.notifiedIds, ['mail-two']);
  assert.deepEqual(JSON.parse(f.outputs[0]), { total: 2, pending: 2, notified: 1, failed: 1 });
  assert.deepEqual(errors, ['fleet-mail-watchdog: 通知確認失敗=1']);
});

test('D6 arrival forwards the bounded abort signal to both Discord transports', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, '.claude', 'orgiast-discord-webhook.txt'), 'https://example.invalid/webhook');
  for (const token of ['test', '']) {
    const controller = new AbortController(), calls = [];
    await notifyArrival({ id: 'mail-signal' }, { home: f.home, token, signal: controller.signal, fetchImpl: async (...args) => { calls.push(args); return { ok: true }; } });
    assert.equal(calls[0][1].signal, controller.signal);
    controller.abort(); assert.equal(calls[0][1].signal.aborted, true);
  }
});
test('lane-health notes are marked seen once; other and already-seen mail are left alone', async () => {
  const body = JSON.stringify({ kind: 'lane-health', pc: 'PC', dead: [] });
  const inbox = [
    { id: 'mail-lh', status: 'delivered', why: '[lane-health] PC glm dead', body },
    { id: 'mail-lh-seen', status: 'seen', seenAt: 'x', why: '[lane-health] PC', body },
    { id: 'mail-human', status: 'delivered', why: '確認お願いします', body: 'hi' },
  ];
  const synced = [];
  const marked = await markLaneHealthSeen({ home: 'h', request: async () => ({}), readInboxImpl: () => inbox, sync: async args => { synced.push([args.id, args.action, args.seenBy]); return true; }, stderr() {} });
  assert.equal(marked, 1); assert.deepEqual(synced, [['mail-lh', 'seen', 'lane-health-watch']]);
});
test('dry run never marks lane-health notes seen', async t => {
  const f = fixture(t); let called = 0; await main(['--dry-run'], { ...f.deps, markLaneHealthSeen: async () => { called++; } }); assert.equal(called, 0);
  await main([], { ...f.deps, markLaneHealthSeen: async () => { called++; } }); assert.equal(called, 1);
});
