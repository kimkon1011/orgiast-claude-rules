import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fleetLabels, collectUndelivered, formatUndelivered, notifiable, main, CHANNEL, STALE_MS, RENOTIFY_MS } from './fleet-mail-watchdog.mjs';

const NOW = Date.parse('2026-10-10T06:00:00.000Z');
const iso = ms => new Date(NOW - ms).toISOString();
const message = (overrides = {}) => ({ id: 'mail-1', status: 'new', createdAt: iso(31 * 60 * 1000), from: 'cr-PC', to: 'kim-PC', why: '返信', ...overrides });

function fixture(t, { configured = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mail-watchdog-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  if (configured) fs.writeFileSync(path.join(dir, 'fleet-sheet.env'), 'FLEET_SHEET_URL="https://example.invalid/mail"\nFLEET_SHEET_TOKEN=test-token\n');
  return { home, dir };
}
const deps = (home, poll, { post, notify, out, errors, token = 'watchdog-token', request } = {}) => ({
  home, now: () => NOW, poll, postChannel: post, notifyKim: notify, token, request,
  stdout: out ?? (() => {}), stderr: errors ? (t => errors.push(t)) : (() => {}),
});

test('fleetLabels excludes reserved keys and falls back to the label as hostname', () => {
  const labels = fleetLabels({ _note: { remoteName: 'x' }, 'kim-PC': { remoteName: '表示名' }, 'cr-PC': {}, broken: null });
  assert.equal(JSON.stringify(labels), JSON.stringify([{ label: 'kim-PC', hostname: '表示名' }, { label: 'cr-PC', hostname: 'cr-PC' }]));
});

test('collectUndelivered aggregates status=new older than 30 minutes and dedupes broadcast ids', async () => {
  const polls = [];
  const entries = await collectUndelivered(
    [{ label: 'kim-PC', hostname: 'h1' }, { label: 'cr-PC', hostname: 'h2' }],
    async ({ label }) => {
      polls.push(label);
      return label === 'kim-PC'
        ? [message(), message({ id: 'mail-fresh', createdAt: iso(STALE_MS - 60_000) }), message({ id: 'mail-done', status: 'delivered' }), message({ id: 'mail-bad', createdAt: 'not-a-date' })]
        : [message(), message({ id: 'mail-own', to: 'cr-PC' })];
    },
    { now: () => NOW });
  assert.equal(JSON.stringify(polls), JSON.stringify(['kim-PC', 'cr-PC']));
  assert.equal(JSON.stringify(entries.map(e => e.id).sort()), JSON.stringify(['mail-1', 'mail-own']));
  assert.equal(entries.find(e => e.id === 'mail-1').to, 'kim-PC', 'all 宛の重複は最初のラベルに一意化');
});

test('formatUndelivered truncates why to 30 chars and shows elapsed minutes', () => {
  const text = formatUndelivered([{ id: 'mail-9', to: 'kim-PC', from: 'cr-PC', why: 'あ'.repeat(40), createdAt: iso(90 * 60 * 1000) }], NOW);
  assert.match(text, /未配達 1件/);
  assert.match(text, /kim-PC 宛 cr-PC から「あ{30}」\(90分経過\) id=mail-9/);
});

test('notifiable suppresses the same id within 6 hours only', () => {
  const entries = [{ id: 'mail-a' }, { id: 'mail-b' }];
  const state = { notified: { 'mail-a': iso(6 * 60 * 60 * 1000) } }; // ちょうど6時間前 = 抑止対象外
  assert.equal(JSON.stringify(notifiable(entries, state, NOW).map(e => e.id)), JSON.stringify(['mail-a', 'mail-b']));
  const within = { notified: { 'mail-a': new Date(NOW - RENOTIFY_MS + 60_000).toISOString() } };
  assert.equal(JSON.stringify(notifiable(entries, within, NOW).map(e => e.id)), JSON.stringify(['mail-b']));
});

test('main skips silently when transport is unconfigured', async t => {
  const f = fixture(t, { configured: false });
  const errors = [];
  assert.equal(await main([], deps(f.home, async () => assert.fail('poll called'), { errors })), 0);
  assert.equal(errors.length, 1);
});

test('main notifies Discord channel and kim DM, records state, and suppresses repeats', async t => {
  const f = fixture(t);
  const posted = [], dms = [], out = [];
  const run = () => main([], deps(f.home, 
    async () => [message({ why: '[判断依頼] 進行方針' })],
    {
      post: async (token, channelId, content) => { posted.push({ token, channelId, content }); },
      notify: async text => { dms.push(text); return { delivered: 'dm' }; },
      out: t2 => out.push(t2),
    }));
  assert.equal(await run(), 0);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].channelId, CHANNEL);
  assert.equal(posted[0].token, 'watchdog-token');
  assert.match(posted[0].content, /未配達 1件/);
  assert.match(posted[0].content, /「\[判断依頼\] 進行方針」/);
  assert.equal(dms.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-mail-watchdog.json'), 'utf8'));
  assert.ok(state.notified['mail-1']);
  // 同じ id は再通知しない（6時間抑止）
  assert.equal(await run(), 0);
  assert.equal(posted.length, 1);
  assert.equal(dms.length, 1);
  assert.match(out.at(-1), /未配達なし/);
});

test('main does not record state when every delivery path fails', async t => {
  const f = fixture(t);
  const run = () => main([], deps(f.home, async () => [message()],
    { post: async () => { throw new Error('discord down'); }, notify: async () => { throw new Error('dm down'); } }));
  assert.equal(await run(), 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'fleet-mail-watchdog.json')), false, '全経路失敗時は次の毎時実行で再通知する');
});

test('main --dry-run prints without sending or writing state', async t => {
  const f = fixture(t);
  const out = [];
  assert.equal(await main(['--dry-run'], deps(f.home, async () => [message()], { out: t2 => out.push(t2) })), 0);
  assert.match(out[0], /^\[DRY\] /);
  assert.match(out[0], /未配達 1件/);
  assert.equal(fs.existsSync(path.join(f.dir, 'fleet-mail-watchdog.json')), false);
});

test('main passes dryRun:true polls so nothing is marked delivered', async t => {
  const f = fixture(t);
  const payloads = [];
  await main([], deps(f.home, async () => []), { request: async (kind, payload) => { payloads.push({ kind, payload }); return { messages: [] }; } });
  assert.ok(payloads.every(p => p.kind === undefined || p.payload.dryRun === true));
});
