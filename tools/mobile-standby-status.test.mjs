import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isStandby, summarize, listRemoteSessions, planOpenCommand, replenishStandby,
  localBridgeIds, checkStandby, defaultGoal, main,
} from './mobile-standby-status.mjs';

const HOUR = 3_600_000;
const standby = (title, extra = {}) => ({ id: `cse_${title}`, status: 'active', connection_status: 'connected', title, ...extra });
const response = (data, next_cursor) => ({ ok: true, json: async () => ({ data, ...(next_cursor ? { next_cursor } : {}) }) });

function tempHome({ local = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-mobile-standby-'));
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token' } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org' } }));
  for (const [name, body] of local) fs.writeFileSync(path.join(home, '.claude', 'sessions', name), JSON.stringify(body));
  return home;
}

test('counts only active, connected, unused auto-named sessions', () => {
  assert.equal(isStandby(standby('remote-control-rosy-cookie')), true);
  assert.equal(isStandby(standby('remote-control-rosy-cookie\nsecond line')), true);
  assert.equal(isStandby(standby('011-prancy-dusk')), true);
  assert.equal(isStandby(standby('desktop-n429m3v-snug-peacock')), true);
  assert.equal(isStandby(standby('011-prancy-dusk', { status: 'archived' })), false);
  assert.equal(isStandby(standby('011-prancy-dusk', { connection_status: 'disconnected' })), false);
  assert.equal(isStandby(standby('ソウルシンク停止')), false);
  assert.equal(isStandby(standby('Claude Code')), false);
  assert.equal(isStandby(null), false);
});

test('treats a session that has already been used as not standby', () => {
  const used = standby('011-imperative-stearns', { external_metadata: { context_usage: { used_tokens: 200625 } } });
  assert.equal(isStandby(used), false);
  assert.equal(isStandby(standby('011-prancy-dusk', { external_metadata: { context_usage: { used_tokens: 0 } } })), true);
  assert.equal(isStandby(standby('011-prancy-dusk', { external_metadata: {} })), true);
});

test('keeps only the sessions of this PC when local ids are given', () => {
  const localIds = new Set(['011-prancy-dusk']);
  assert.equal(isStandby(standby('011-prancy-dusk'), { localIds }), true);
  assert.equal(isStandby(standby('desktop-n429m3v-snug-peacock'), { localIds }), false);
  assert.equal(isStandby(standby('remote-control-a-b'), { localIds }), false);
  // localIds を渡さなければアカウント全体で数える（従来どおり）。
  assert.equal(isStandby(standby('desktop-n429m3v-snug-peacock')), true);
  // サーバー側は cse_、ローカル帳簿は session_ 接頭辞。どちらでも同じ id として突き合わせる。
  assert.equal(isStandby({ id: 'cse_abc', status: 'active', connection_status: 'connected', title: '011-prancy-dusk' }, { localIds: new Set(['abc']) }), true);
});

test('summarize reports the shortfall and titles', () => {
  const localIds = new Set(['remote-control-a-b', '011-calm-otter']);
  const sessions = [
    standby('remote-control-a-b'),
    standby('remote-control-c-d', { connection_status: 'disconnected' }),
    standby('会話タイトル'),
    standby('011-calm-otter'),
    standby('desktop-2d0r4li-happy-otter'),
  ];
  assert.deepEqual(
    summarize(sessions, 2, { localIds }),
    { goal: 2, standby: 2, shortfall: 0, titles: ['remote-control-a-b', '011-calm-otter'] },
  );
  assert.equal(summarize(sessions, 3, { localIds }).shortfall, 1);
});

test('localBridgeIds keeps only living sessions holding a bridgeSessionId', () => {
  const home = tempHome({
    local: [
      ['111.json', { bridgeSessionId: 'session_a' }],
      ['222.json', { bridgeSessionId: 'session_b' }],
      ['333.json', { sessionId: 'not-bridged' }],
      ['444.json', { bridgeSessionId: 'session_c' }],
      ['555.json.bak', { bridgeSessionId: 'session_dead' }],
    ],
  });
  const ids = localBridgeIds(home, { isAlive: (pid) => pid !== 222 && pid !== 555 });
  fs.rmSync(home, { recursive: true, force: true });
  assert.deepEqual([...ids].sort(), ['a', 'c']);
});

test('localBridgeIds returns an empty set when the ledger is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-mobile-standby-empty-'));
  const ids = localBridgeIds(home);
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(ids.size, 0);
});

test('checkStandby counts only sessions whose pid is alive on this PC', async () => {
  const home = tempHome({ local: [[`${process.pid}.json`, { bridgeSessionId: 'session_abc' }]] });
  const result = await checkStandby({
    home,
    goal: 2,
    fetchImpl: async () => response([
      { ...standby('011-prancy-dusk'), id: 'cse_abc' },
      { ...standby('desktop-n429m3v-snug-peacock'), id: 'cse_xyz' },
    ]),
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.standby, 1);
  assert.deepEqual(result.titles, ['011-prancy-dusk']);
  assert.equal(result.listed, 2);
});

test('listRemoteSessions follows next_cursor', async () => {
  const pages = [response([standby('remote-control-a-b')], 'p2'), response([standby('remote-control-c-d')])];
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return pages.shift(); };
  const result = await listRemoteSessions({ headers: { Authorization: 'x' }, fetchImpl });
  assert.equal(result.sessions.length, 2);
  assert.match(seen[1], /cursor=p2/);
});

test('listRemoteSessions reports the HTTP failure without throwing', async () => {
  const result = await listRemoteSessions({ headers: {}, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(result, { sessions: [], error: 'list 401' });
});

test('planOpenCommand is null without the VSCode CLI', () => {
  assert.equal(planOpenCommand({ codeCli: '' }), null);
  const plan = planOpenCommand({ codeCli: 'C:/code.cmd' });
  assert.equal(plan.command, 'cmd.exe');
  assert.match(plan.args[1], /code\.cmd" --open-url "vscode:\/\/Anthropic\.claude-code\/open"/);
});

test('defaultGoal reads the count from mobile-sessions.json', () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), JSON.stringify({ count: 3, refreshMinutes: 0 }));
  assert.equal(defaultGoal(home), 3);
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), JSON.stringify({ count: 0 }));
  assert.equal(defaultGoal(home), 2);
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), JSON.stringify({ count: 2.5 }));
  assert.equal(defaultGoal(home), 2);
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), JSON.stringify({ count: '3' }));
  assert.equal(defaultGoal(home), 3);
  fs.rmSync(path.join(home, '.claude', 'mobile-sessions.json'));
  assert.equal(defaultGoal(home), 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('main uses the configured goal when --goal is omitted', async () => {
  // 資格情報を置かないので API には出ず、目標本数だけを確かめられる。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-mobile-standby-goal-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), JSON.stringify({ count: 3 }));
  let logged = '';
  const code = await main(['--status'], { homedir: home, log: (text) => { logged = text; } });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(JSON.parse(logged).goal, 3);
  assert.equal(JSON.parse(logged).error, 'no-credentials');
  assert.equal(code, 1);
});

test('skips without credentials instead of opening tabs', async () => {
  let opened = 0;
  let slept = false;
  const result = await replenishStandby({
    home: path.join(os.tmpdir(), 'orgiast-mobile-standby-missing-home'),
    fetchImpl: async () => response([]),
    codeCli: 'C:/code.cmd',
    open: async () => { opened += 1; return 1; },
    sleep: async () => { slept = true; },
    notify: async () => ({ delivered: 'dm' }),
  });
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'no-credentials');
  assert.equal(opened, 0);
  assert.equal(slept, false);
});

test('opens only the missing tabs and verifies by re-querying the API', async () => {
  const home = tempHome();
  const localIds = new Set(['remote-control-a-b', 'remote-control-c-d']);
  const pages = [response([standby('remote-control-a-b')]), response([standby('remote-control-a-b'), standby('remote-control-c-d')])];
  const opened = [];
  let slept = null;
  const result = await replenishStandby({
    home,
    localIds,
    fetchImpl: async () => pages.shift(),
    codeCli: 'C:/code.cmd',
    open: async ({ count, codeCli }) => { opened.push({ count, codeCli }); return count; },
    sleep: async (ms) => { slept = ms; },
    notify: async () => ({ delivered: 'dm' }),
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.action, 'replenished');
  assert.equal(result.opened, 1);
  assert.deepEqual(opened, [{ count: 1, codeCli: 'C:/code.cmd' }]);
  assert.equal(slept, 30_000);
  assert.equal(result.after.standby, 2);
});

test('notifies when the count does not recover after opening', async () => {
  const home = tempHome();
  const stateFile = path.join(home, '.claude', 'mobile-standby-status-state.json');
  const ts = Date.parse('2026-10-18T00:00:00Z');
  let message = '';
  const result = await replenishStandby({
    home,
    localIds: new Set(),
    fetchImpl: async () => response([]),
    codeCli: 'C:/code.cmd',
    open: async () => 2,
    sleep: async () => {},
    notify: async (text) => { message = text; return { delivered: 'dm' }; },
    now: () => ts,
    stateFile,
  });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.action, 'notified');
  assert.equal(result.opened, 2);
  assert.match(message, /目標 2 本 \/ 現在 0 本/);
  assert.equal(state.notifiedAt, ts);
});

test('suppresses the DM when the same shortfall was notified within 6 hours', async () => {
  const home = tempHome();
  const stateFile = path.join(home, '.claude', 'mobile-standby-status-state.json');
  const notifiedAt = Date.parse('2026-10-18T00:00:00Z');
  fs.writeFileSync(stateFile, JSON.stringify({ at: notifiedAt, notifiedAt }));
  let notified = 0;
  const result = await replenishStandby({
    home,
    localIds: new Set(),
    fetchImpl: async () => response([]),
    codeCli: 'C:/code.cmd',
    open: async () => 2,
    sleep: async () => {},
    notify: async () => { notified += 1; return { delivered: 'dm' }; },
    now: () => notifiedAt + HOUR,
    stateFile,
  });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.action, 'shortfall');
  assert.equal(result.suppressed, true);
  assert.equal(notified, 0);
  assert.equal(state.notifiedAt, notifiedAt);
  assert.equal(state.at, notifiedAt + HOUR);
});

test('notifies again after the 6 hour notify cooldown', async () => {
  const home = tempHome();
  const stateFile = path.join(home, '.claude', 'mobile-standby-status-state.json');
  const notifiedAt = Date.parse('2026-10-18T00:00:00Z');
  fs.writeFileSync(stateFile, JSON.stringify({ at: notifiedAt, notifiedAt }));
  let notified = 0;
  const ts = notifiedAt + 6 * HOUR;
  const result = await replenishStandby({
    home,
    localIds: new Set(),
    fetchImpl: async () => response([]),
    codeCli: 'C:/code.cmd',
    open: async () => 1,
    sleep: async () => {},
    notify: async () => { notified += 1; return { delivered: 'dm' }; },
    now: () => ts,
    stateFile,
  });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.action, 'notified');
  assert.equal(notified, 1);
  assert.equal(state.notifiedAt, ts);
});

test('replenish does nothing when the goal is already met, but records the cooldown', async () => {
  const home = tempHome();
  let opened = 0;
  const stateFile = path.join(home, '.claude', 'mobile-standby-status-state.json');
  const result = await replenishStandby({
    home,
    localIds: new Set(['remote-control-a-b', 'remote-control-c-d']),
    fetchImpl: async () => response([standby('remote-control-a-b'), standby('remote-control-c-d')]),
    codeCli: 'C:/code.cmd',
    open: async () => { opened += 1; return 1; },
    sleep: async () => {},
    notify: async () => ({ delivered: 'dm' }),
    now: () => Date.parse('2026-10-18T00:00:00Z'),
    stateFile,
  });
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.action, 'none');
  assert.equal(opened, 0);
  assert.deepEqual(state, { at: Date.parse('2026-10-18T00:00:00Z'), standby: 2, goal: 2 });
});

test('disabled PC never opens standby tabs or fetches remote status for replenishment', async () => {
  const { openStandbyTabs } = await import('./mobile-standby-status.mjs');
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.claude', 'mobile-sessions.json'), '{"enabled":false}');
  assert.equal(await openStandbyTabs({ home, count: 3, codeCli: 'code.cmd', spawnProcess() { assert.fail(); } }), 0);
  assert.deepEqual(await replenishStandby({ home, fetchImpl() { assert.fail(); }, open() { assert.fail(); } }), { action: 'skipped', reason: 'disabled' });
});
