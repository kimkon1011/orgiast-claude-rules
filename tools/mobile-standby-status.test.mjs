import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isStandby, summarize, listRemoteSessions, planOpenCommand, replenishStandby,
} from './mobile-standby-status.mjs';

const standby = (title, extra = {}) => ({ status: 'active', connection_status: 'connected', title, ...extra });
const response = (data, next_cursor) => ({ ok: true, json: async () => ({ data, ...(next_cursor ? { next_cursor } : {}) }) });

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-mobile-standby-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'token' } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org' } }));
  return home;
}

test('counts only active, connected, unused remote-control sessions', () => {
  assert.equal(isStandby(standby('remote-control-rosy-cookie')), true);
  assert.equal(isStandby(standby('remote-control-rosy-cookie\nsecond line')), true);
  assert.equal(isStandby(standby('remote-control-rosy-cookie', { status: 'archived' })), false);
  assert.equal(isStandby(standby('remote-control-rosy-cookie', { connection_status: 'disconnected' })), false);
  assert.equal(isStandby(standby('ソウルシンク停止')), false);
  assert.equal(isStandby(standby('desktop-2d0r4li-happy-otter')), false);
  assert.equal(isStandby(null), false);
});

test('summarize reports the shortfall and titles', () => {
  const sessions = [
    standby('remote-control-a-b'),
    standby('remote-control-c-d', { connection_status: 'disconnected' }),
    standby('会話タイトル'),
  ];
  assert.deepEqual(summarize(sessions, 2), { goal: 2, standby: 1, shortfall: 1, titles: ['remote-control-a-b'] });
  assert.equal(summarize(sessions, 1).shortfall, 0);
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
  const pages = [response([standby('remote-control-a-b')]), response([standby('remote-control-a-b'), standby('remote-control-c-d')])];
  const opened = [];
  let slept = null;
  const result = await replenishStandby({
    home,
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
  const pages = [response([]), response([])];
  let message = '';
  const result = await replenishStandby({
    home,
    fetchImpl: async () => pages.shift(),
    codeCli: 'C:/code.cmd',
    open: async () => 2,
    sleep: async () => {},
    notify: async (text) => { message = text; return { delivered: 'dm' }; },
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(result.action, 'notified');
  assert.equal(result.opened, 2);
  assert.match(message, /目標 2 本 \/ 現在 0 本/);
});

test('replenish does nothing when the goal is already met, but records the cooldown', async () => {
  const home = tempHome();
  let opened = 0;
  const stateFile = path.join(home, '.claude', 'mobile-standby-status-state.json');
  const result = await replenishStandby({
    home,
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
