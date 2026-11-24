import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClassifyPrompt, cleanupState, collectNew, initialState, isGmailNoise, retryDispatches, routeItems, ruleRoute, parseRoute, run, writeDigest } from './inbound-router.mjs';

const NOW = Date.parse('2026-11-23T06:10:00.000Z');
const config = {
  excludeNetworks: ['ChatGPT Dots', 'Grok Bot', 'Muse'],
  routes: {
    learning: { pc: '000', target: '000KimPC', session: 'session-1', cwd: 'C:\\work', description: 'あつまる石井塾 ラーニング勉強会（陽介さん・健作さん）' },
    sales: { pc: '011', target: '作業用011', cwd: 'C:\\work', description: '新規問い合わせ・見積（ブース以外の営業案件）' },
    'discord-existing': { pc: '000', target: '000KimPC', cwd: 'C:\\work', description: 'Discord の既存自動応答（OrgiastDiscordAutoReply が全件対応、二重配送防止のため dispatch:false）', dispatch: false }
  },
  rules: [
    { route: 'discord-existing', networks: ['Discord'] },
    { route: 'learning', chatIds: ['!ChIBuV99wU4lPhmKYZzu:beeper.local'], includes: ['石井塾'], matchBody: true }
  ]
};
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-router-'));
const baseDeps = overrides => ({
  getAccounts: async () => [], listChats: async () => ({ items: [], hasMore: false }), listMessages: async () => ({ items: [], hasMore: false }),
  searchGmail: async () => ({ messages: [] }), classify: async () => '{"route":"unknown"}', sendFleet: async () => ({ id: 'mail-1', method: 'fleet-mail' }), launchLocal: async () => ({ id: 'local-1', method: 'local-hidden' }), statusFleet: async () => 'done', statusLocal: async () => 'done', ...overrides
});
const options = home => ({ home, stateFile: path.join(home, '.claude', 'inbound-router', 'state.json'), config, now: NOW, dryRun: true });

test('実設定は learning と discord-existing 以外を @rules-repo にする', () => {
  const actual = JSON.parse(fs.readFileSync(new URL('../config/inbound-router.json', import.meta.url), 'utf8'));
  for (const [name, route] of Object.entries(actual.routes)) {
    if (!['learning', 'discord-existing'].includes(name)) assert.equal(route.cwd, '@rules-repo', name);
  }
});

test('新着0件で llm-ask と fleet-mail を呼ばない', async () => {
  let classify = 0, fleet = 0; const home = temp();
  const result = await run(options(home), baseDeps({ classify: async () => { classify++; }, sendFleet: async () => { fleet++; }, statusFleet: async () => { fleet++; return 'pending'; } }));
  assert.equal(result.new.beeper + result.new.gmail, 0); assert.equal(classify, 0); assert.equal(fleet, 0);
});

test('送信直後の新着0件では状態照会を含めfleet-mailを呼ばない', async () => {
  const home = temp(), stateFile = path.join(home, 'state.json'), state = initialState();
  state.dispatches.push({ id: 'recent', route: 'sales', status: 'sent', sentAt: NOW - 60_000, attempts: 1 });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  let calls = 0;
  const result = await run({ ...options(home), stateFile }, baseDeps({
    classify: async () => { calls++; }, sendFleet: async () => { calls++; }, statusFleet: async () => { calls++; return 'pending'; }
  }));
  assert.equal(calls, 0);
  assert.deepEqual(result.calls, { classify: 0, fleetSend: 0, fleetStatus: 0 });
  assert.deepEqual(result.routed, {});
});

test('明示したsinceMinutesは読取位置を遡り既読IDを重複配送しない', async () => {
  const home = temp(), stateFile = path.join(home, 'state.json'), state = initialState();
  state.sources = { beeper: NOW - 60_000, 'gmail:kim@orgiast.jp': NOW - 60_000, 'gmail:seisaku-team@orgiast.jp': NOW - 60_000 };
  state.seen['gmail:kim@orgiast.jp:seen'] = NOW - 60_000;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const queries = [];
  const result = await run({ ...options(home), stateFile, sinceMinutes: 240 }, baseDeps({
    searchGmail: async ({ query, user, skipId }) => {
      queries.push(query);
      if (user !== 'kim@orgiast.jp') return { messages: [] };
      return { messages: ['seen', 'unseen'].filter(id => !skipId(id)).map(id => ({ id, threadId: id, internalDate: NOW - 120 * 60_000, from: 'a@example.com', subject: '石井塾', body: '' })) };
    }
  }));
  assert.ok(queries.every(query => query.includes(`after:${Math.floor((NOW - 241 * 60_000) / 1000)}`)));
  assert.equal(result.new.gmail, 1);
  assert.equal(result.routed.learning, 1);
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
  let calls = 0; const ok = await routeItems([item], { config, state: initialState(), classify: async () => { calls++; return '{"route":"sales","confidence":0.9}'; } }); assert.equal(calls, 1); assert.equal(ok.groups.sales.length, 1);
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

test('confidence 0.7未満は unknown 扱い', () => {
  const config = { routes: { sales: { pc: '011' } } };
  assert.equal(parseRoute('{"route":"sales","confidence":0.8}', config), 'sales');
  assert.equal(parseRoute('{"route":"sales","confidence":0.6}', config), 'unknown');
  assert.equal(parseRoute('{"route":"sales"}', config), 'unknown');
});

test('Discordメッセージはdiscord-existingルートへ、dispatch=falseならグループに追加しない', async () => {
  const state = initialState();
  const item = { kind: 'beeper', source: 'beeper:x', id: 'd1', chatId: 'discord-1', network: 'Discord', title: 'Discord message', sender: 'User', text: 'Hello', time: new Date(NOW).toISOString() };

  // First, check ruleRoute directly
  const route = ruleRoute(item, config, state);
  assert.equal(route, 'discord-existing');

  // Then check routeItems
  const routed = await routeItems([item], { config, state, classify: async () => { throw new Error('should not be called'); } });
  // Should not be in groups because dispatch is false
  assert.equal(Object.keys(routed.groups).length, 0);
  // But should also not be in unknown
  assert.equal(routed.unknown.length, 0);
});

test('古いstateエントリーは14日後に削除', () => {
  const state = initialState();
  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60_000;
  const fifteenDaysAgo = now - 15 * 24 * 60 * 60_000;

  // Add old entries
  state.seen['old-key'] = fourteenDaysAgo - 1000;
  state.seen['new-key'] = now;
  state.unknown.push({ id: 'old-unknown', reportedAt: new Date(fifteenDaysAgo).toISOString() });
  state.unknown.push({ id: 'new-unknown', reportedAt: new Date(now).toISOString() });

  cleanupState(state, now);
  assert.equal(state.seen['old-key'], undefined);
  assert.ok(state.seen['new-key']);
  assert.deepEqual(state.unknown.map(x => x.id), ['new-unknown']);
});

test('設定した自動メールと件名をnoise扱いし自社Fromは除外しない', () => {
  const noiseConfig = { noiseSenders: ['notifications@github\\.com', '@share\\.timescar', '@notice\\.', 'mailer-daemon'], noiseSubjects: ['^Delivery Status Notification', '返却証|お支払いを受領'] };
  assert.equal(isGmailNoise({ from: 'notifications@github.com', subject: 'x' }, noiseConfig), true);
  assert.equal(isGmailNoise({ from: 'inquiry@share.timescar.jp', subject: '返却証' }, noiseConfig), true);
  assert.equal(isGmailNoise({ from: 'credit@notice.alibaba.com', subject: 'お支払いを受領' }, noiseConfig), true);
  assert.equal(isGmailNoise({ from: 'mailer-daemon@example.com', subject: 'Delivery Status Notification' }, noiseConfig), true);
  assert.equal(isGmailNoise({ from: 'seisaku-team@orgiast.jp', subject: 'Delivery Status Notification' }, noiseConfig), false);
});

test('件名・チャット名・送信者だけで学会をboothより優先し本文はmatchBody時だけ見る', () => {
  const routingConfig = { routes: { gakkai: {}, booth: {}, learning: {} }, rules: [
    { route: 'gakkai', includes: ['学術集会'] }, { route: 'learning', includes: ['石井塾'], matchBody: true }, { route: 'booth', includes: ['展示'] }
  ] };
  const state = initialState();
  assert.equal(ruleRoute({ kind: 'gmail', mailbox: 'x', threadId: '1', title: '第14回JADEC年次学術集会／企業展示', sender: '医学会', text: '' }, routingConfig, state), 'gakkai');
  assert.equal(ruleRoute({ kind: 'gmail', mailbox: 'x', threadId: '2', title: '雑談', sender: '友人', text: '展示について' }, routingConfig, state), null);
  assert.equal(ruleRoute({ kind: 'gmail', mailbox: 'x', threadId: '3', title: '連絡', sender: '講師', text: '石井塾の日程' }, routingConfig, state), 'learning');
});

test('同一threadのルール不一致項目はAI判定を1回だけ呼ぶ', async () => {
  const items = [1, 2].map(id => ({ kind: 'gmail', source: 'gmail:x', id: String(id), mailbox: 'x', threadId: 'same', title: '無題', sender: 'a', text: `本文${id}` }));
  let calls = 0; const routed = await routeItems(items, { config, state: initialState(), classify: async () => { calls++; return '{"route":"sales","confidence":0.9}'; } });
  assert.equal(calls, 1); assert.equal(routed.groups.sales.length, 2);
});

test('AI判定プロンプトに全routeの説明・unknown条件・confidenceを含める', () => {
  const prompt = buildClassifyPrompt({ title: '私用', sender: '友人', text: '食事' }, config);
  for (const [route, value] of Object.entries(config.routes)) assert.match(prompt, new RegExp(`${route}: ${value.description}`));
  assert.match(prompt, /個人・家族・友人・雑談/); assert.match(prompt, /confidence/);
});

test('common.ps1がある時はGB-WriteReport経由でsummaryを更新する', { skip: process.platform !== 'win32' }, () => {
  const home = temp(), reportDir = path.join(home, 'gb-reports'), offloadDir = path.join(home, 'gb-offload');
  fs.mkdirSync(offloadDir); fs.writeFileSync(path.join(offloadDir, 'common.ps1'), "function GB-WriteReport { param($Job,$Body,$Flags,$Status) Set-Content -Path (Join-Path $PSScriptRoot 'called.txt') -Value \"$Job|$Flags|$Status\" }");
  const state = initialState(); state.unknown.push({ id: 'u', item: { kind: 'gmail', mailbox: 'x', title: '要確認', sender: 'a', time: new Date(NOW).toISOString(), text: 'x' } });
  assert.ok(writeDigest({ state, now: NOW, reportDir }));
  assert.match(fs.readFileSync(path.join(offloadDir, 'called.txt'), 'utf8'), /inbound-router\|1\|/);
  assert.equal(fs.existsSync(path.join(reportDir, 'summary.md')), false);
});
