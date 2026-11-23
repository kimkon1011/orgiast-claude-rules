import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectNew, initialState, retryDispatches, routeItems, run, writeDigest } from './inbound-router.mjs';

const NOW = Date.parse('2026-11-23T06:10:00.000Z');
const config = {
  excludeNetworks: ['ChatGPT Dots', 'Grok Bot', 'Muse'],
  routes: {
    learning: { pc: '000', target: '000KimPC', session: 'session-1', cwd: 'C:\\work' },
    sales: { pc: '011', target: '作業用011', cwd: 'C:\\work' }
  },
  rules: [{ route: 'learning', chatIds: ['!ChIBuV99wU4lPhmKYZzu:beeper.local'], includes: ['石井塾'] }]
};
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-router-'));
const baseDeps = overrides => ({
  getAccounts: async () => [], listChats: async () => ({ items: [], hasMore: false }), listMessages: async () => ({ items: [], hasMore: false }),
  searchGmail: async () => ({ messages: [] }), classify: async () => '{"route":"unknown"}', sendFleet: async () => ({ id: 'mail-1', method: 'fleet-mail' }), launchLocal: async () => ({ id: 'local-1', method: 'local-hidden' }), statusFleet: async () => 'done', statusLocal: async () => 'done', ...overrides
});
const options = home => ({ home, stateFile: path.join(home, '.claude', 'inbound-router', 'state.json'), config, now: NOW, dryRun: true });

test('新着0件で llm-ask と fleet-mail を呼ばない', async () => {
  let classify = 0, fleet = 0; const home = temp();
  const result = await run(options(home), baseDeps({ classify: async () => { classify++; }, sendFleet: async () => { fleet++; }, statusFleet: async () => { fleet++; return 'pending'; } }));
  assert.equal(result.new.beeper + result.new.gmail, 0); assert.equal(classify, 0); assert.equal(fleet, 0);
});

test('Messenger 講師グループ chatID は learning の 000 session 付き', async () => {
  const state = initialState(), item = { kind: 'beeper', source: 'beeper:x', id: 'm1', chatId: '!ChIBuV99wU4lPhmKYZzu:beeper.local', title: '講師', sender: '陽介', text: '日程', time: new Date(NOW).toISOString() };
  const routed = await routeItems([item], { config, state, classify: async () => { throw new Error('unexpected'); } });
  assert.equal(routed.groups.learning.length, 1); assert.equal(config.routes.learning.pc, '000'); assert.equal(config.routes.learning.session, 'session-1');
});

test('自分の送信と除外ネットワークは無視', async () => {
  const state = initialState();
  const result = await collectNew({ state, config, since: NOW - 3600_000, until: NOW, deps: baseDeps({
    getAccounts: async () => [{ accountID: 'human', network: 'Messenger' }, { accountID: 'ai', network: 'Muse' }],
    listChats: async () => ({ items: [{ id: 'h', accountID: 'human', network: 'Messenger', lastActivity: new Date(NOW).toISOString() }, { id: 'ai', accountID: 'ai', network: 'Muse', lastActivity: new Date(NOW).toISOString() }], hasMore: false }),
    listMessages: async id => ({ items: id === 'h' ? [{ id: 'mine', isSender: true, timestamp: new Date(NOW).toISOString(), text: 'x' }] : [{ id: 'other', timestamp: new Date(NOW).toISOString(), text: 'x' }], hasMore: false })
  }) });
  assert.equal(result.items.length, 0);
});

test('ルール不一致は llm-ask、失敗時 unknown', async () => {
  const item = { kind: 'gmail', source: 'gmail:x', id: 'x', mailbox: 'x', threadId: 't', title: '無題', sender: 'a', text: 'z' };
  let calls = 0; const ok = await routeItems([item], { config, state: initialState(), classify: async () => { calls++; return '{"route":"sales"}'; } }); assert.equal(calls, 1); assert.equal(ok.groups.sales.length, 1);
  const ng = await routeItems([item], { config, state: initialState(), classify: async () => { throw new Error('down'); } }); assert.equal(ng.unknown.length, 1);
});

test('60分未完了で再投入、3回で unknown', async () => {
  const state = initialState(); state.__file = path.join(temp(), 'state.json'); state.dispatches.push({ id: 'd1', method: 'fleet-mail', route: 'sales', pc: '011', itemKeys: ['x'], items: [], sentAt: NOW - 61 * 60_000, attempts: 2, status: 'sent' });
  let sent = 0; const plans = []; await retryDispatches(state, { now: NOW, deps: baseDeps({ statusFleet: async () => 'pending', sendFleet: async () => { sent++; return { id: 'd2', method: 'fleet-mail' }; } }), config, dryRun: false, plans }); assert.equal(sent, 1); assert.equal(state.dispatches[0].attempts, 3);
  state.dispatches[0].sentAt = NOW - 61 * 60_000; await retryDispatches(state, { now: NOW, deps: baseDeps({ statusFleet: async () => 'pending' }), config, dryRun: false, plans }); assert.equal(state.dispatches[0].status, 'abandoned'); assert.equal(state.unknown[0].reason, '渡したが未着手');
});

test('9/15/21時の見回りで summary の他行を保持', () => {
  const dir = temp(), state = initialState(); state.unknown.push({ id: 'u', item: { kind: 'gmail', mailbox: 'kim@orgiast.jp', title: '要返信', sender: 'x', time: new Date(NOW).toISOString(), text: 'こんにちは' }, candidates: ['sales'] }); fs.writeFileSync(path.join(dir, 'summary.md'), '| name | last | status | count | file |\n|---|---|---|---:|---|\n| other | x | ok | 0 | a |\n');
  const file = writeDigest({ state, now: NOW, reportDir: dir }); assert.ok(file); const summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'); assert.match(summary, /\| other \|/); assert.match(summary, /\| inbound-router \|/); assert.ok(fs.existsSync(path.join(dir, 'latest-inbound-router.md')));
});

test('Gmail noise 除外と取得失敗時の読取位置据え置き', async () => {
  const state = initialState(), old = NOW - 7200_000; state.sources['gmail:kim@orgiast.jp'] = old; let calls = 0;
  const result = await collectNew({ state, config, since: old, until: NOW, deps: baseDeps({ searchGmail: async ({ user }) => { calls++; if (user === 'kim@orgiast.jp') throw Object.assign(new Error('down'), { code: 'DOWN' }); return { messages: [{ id: 'n', threadId: 'tn', internalDate: NOW, from: 'noreply@example.com', subject: 'sale', listUnsubscribe: '<x>', labels: ['CATEGORY_PROMOTIONS'], body: 'x' }] }; } }) });
  assert.equal(calls, 2); assert.equal(result.counts.noise, 1); assert.equal(result.items.length, 0); assert.equal(state.sources['gmail:kim@orgiast.jp'], old); assert.equal(state.sources['gmail:seisaku-team@orgiast.jp'], NOW);
});
