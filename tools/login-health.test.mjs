import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem, listItems } from './kim-inbox.mjs';
import {
  probeGithub,
  probeClaude,
  probeCodex,
  probeAiLanes,
  probeBrowserSessions,
  runLoginHealth,
  loginHealthSessionStart,
} from './login-health.mjs';

function createTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'login-health-test-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return home;
}

test('probeGithub classifies a rejected PAT without including the credential in the result', async t => {
  const home = createTestHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [httpStatus, ghStatus, status] of [[200, 0, 'ok'], [200, 1, 'warn'], [401, 0, 'fail']]) {
    const res = await probeGithub({
      home,
      token: 'fixture-credential',
      execImpl: (cmd, args) => {
        assert.equal(cmd, 'gh');
        assert.deepEqual(args, ['auth', 'status']);
        return { status: ghStatus };
      },
      fetchImpl: async () => ({
        status: httpStatus,
        ok: httpStatus === 200,
        json: async () => ({ login: 'testuser' }),
        headers: new Map(),
      }),
    });
    assert.equal(res.status, status);
    if (httpStatus === 401) assert.match(res.detail, /HTTP 401/);
    assert.doesNotMatch(JSON.stringify(res), /fixture-credential/);
  }
});

test('probeCodex: WslService STOP_PENDING returns wsl_hung', async () => {
  const home = createTestHome();
  const mockExec = (cmd, args) => {
    if (cmd === 'sc' && args.includes('WslService')) {
      return { status: 0, stdout: 'STATE: 3 STOP_PENDING' };
    }
    return { status: 0, stdout: '' };
  };

  const res = await probeCodex({ home, execImpl: mockExec, platform: 'win32' });
  assert.equal(res.status, 'fail');
  assert.equal(res.detail, 'wsl_hung (WSLService STOP_PENDING)');

  fs.rmSync(home, { recursive: true, force: true });
});

test('probeCodex: cooldown with 401 in real24h returns auth_lost', async () => {
  const home = createTestHome();
  const now = Date.now();

  fs.writeFileSync(path.join(home, '.claude', 'lane-health.json'), JSON.stringify({
    lanes: {
      codex: {
        alive: false,
        reason: 'quota_wait',
        lastProbeOkAt: new Date(now - 3600000).toISOString(),
        real24h: {
          events: [
            { at: now - 1800000, reason: 'HTTP 401 bearer or basic authentication in header' },
          ],
        },
      },
    },
  }));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: 'valid' } }));

  const mockExec = () => ({ status: 0, stdout: 'STATE: 4 RUNNING' });

  const res = await probeCodex({ home, execImpl: mockExec, platform: 'win32', now });
  assert.equal(res.status, 'fail');
  assert.equal(res.detail, 'auth_lost (401/認証切れ)');

  fs.rmSync(home, { recursive: true, force: true });
});

test('probeAiLanes: lastProbeOkAt > 24h returns stale', async () => {
  const home = createTestHome();
  const now = Date.now();
  const staleTime = new Date(now - 25 * 3600_000).toISOString();

  fs.writeFileSync(path.join(home, '.claude', 'lane-health.json'), JSON.stringify({
    lanes: {
      deepseek: { alive: true, lastProbeOkAt: staleTime },
    },
  }));

  const res = await probeAiLanes({ home, now });
  const deepseek = res.find(r => r.id === 'ai-lane:deepseek');
  assert.equal(deepseek.status, 'stale');

  fs.rmSync(home, { recursive: true, force: true });
});

test('probeBrowserSessions: loggedIn=false + needsHumanSince calculates days and returns fail', async () => {
  const home = createTestHome();
  const now = Date.now();
  const tenDaysAgo = new Date(now - 10 * 86400_000).toISOString();

  fs.writeFileSync(path.join(home, '.claude', 'beds24-session-state.json'), JSON.stringify({
    checkedAt: new Date(now - 3600_000).toISOString(),
    loggedIn: false,
    needsHuman: true,
    needsHumanSince: tenDaysAgo,
  }));

  const res = await probeBrowserSessions({ home, now });
  const beds24 = res.find(r => r.id === 'browser:beds24');
  assert.equal(beds24.status, 'fail');
  assert.equal(beds24.detail, 'beds24 未ログイン (10日)');

  fs.rmSync(home, { recursive: true, force: true });
});

test('probeBrowserSessions: remedy does not contain https://<service>.com format and uses fixed service mapping', async () => {
  const home = createTestHome();
  const now = Date.now();

  const services = ['booking', 'beds24', 'airbnb', 'nomu-gmail', 'unknown-svc'];
  for (const svc of services) {
    fs.writeFileSync(path.join(home, '.claude', `${svc}-session-state.json`), JSON.stringify({
      checkedAt: new Date(now).toISOString(),
      loggedIn: false,
    }));
  }

  const res = await probeBrowserSessions({ home, now });
  assert.equal(res.length, services.length);

  for (const item of res) {
    assert.equal(/https:\/\/[^/]+\.com/.test(item.remedy), false, `remedy should not contain https://<service>.com: ${item.remedy}`);
    assert.equal(item.remedy.includes('open-url-as.ps1'), false, `remedy should not contain open-url-as.ps1: ${item.remedy}`);
  }

  const booking = res.find(r => r.id === 'browser:booking');
  assert.ok(booking.remedy.includes('Booking.comログイン窓'), `booking remedy should include 'Booking.comログイン窓', got: ${booking.remedy}`);

  const beds24 = res.find(r => r.id === 'browser:beds24');
  assert.equal(beds24.remedy, 'node tools/browser/beds24-keepalive.mjs --ping で状態確認し、reCAPTCHA が出ていれば CDP 9222 の窓で1回ログイン');

  const airbnb = res.find(r => r.id === 'browser:airbnb');
  assert.equal(airbnb.remedy, 'CDP 9223 の窓で1回ログイン');

  const nomuGmail = res.find(r => r.id === 'browser:nomu-gmail');
  assert.equal(nomuGmail.remedy, 'node tools/browser/nomu-gmail-keepalive.mjs --ensure で窓を起動し1回ログイン');

  const unknownSvc = res.find(r => r.id === 'browser:unknown-svc');
  assert.equal(unknownSvc.remedy, '~/.claude/unknown-svc-session-state.json の reason を確認し、該当の keepalive の窓で1回ログイン');

  fs.rmSync(home, { recursive: true, force: true });
});

test('runLoginHealth notify: dedupeKey prevents creating duplicates and a recurrence reopens the ask', async t => {
  const home = createTestHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now();

  const mockIo = {
    addKimInboxItem: (inboxHome, item) => addItem(inboxHome, item, { drain: false, localOnly: true }),
  };
  const beds24Items = () => listItems(home).filter(i => i.dedupeKey?.includes('beds24'));

  fs.writeFileSync(path.join(home, '.claude', 'beds24-session-state.json'), JSON.stringify({
    checkedAt: new Date(now).toISOString(),
    loggedIn: false,
    needsHumanSince: new Date(now - 86400000).toISOString(),
  }));

  const mockExec = (cmd) => {
    if (cmd === 'sc') return { status: 0, stdout: 'STATE: 4 RUNNING' };
    return { status: 0, stdout: '' };
  };

  // Run 1
  await runLoginHealth({ home, notify: true, execImpl: mockExec, token: null, fetchImpl: async () => assert.fail('unexpected fetch'), now, io: mockIo });
  const beds24Items1 = beds24Items();
  assert.equal(beds24Items1.length, 1);
  assert.equal(beds24Items1[0].dedupeKey, `login-health:${os.hostname()}:browser:beds24`);

  // Run 2 (same failure)
  await runLoginHealth({ home, notify: true, execImpl: mockExec, token: null, fetchImpl: async () => assert.fail('unexpected fetch'), now, io: mockIo });
  const beds24Items2 = beds24Items();
  assert.equal(beds24Items2.length, 1); // No new duplicate item created

  // Run 3 (recovered)
  fs.writeFileSync(path.join(home, '.claude', 'beds24-session-state.json'), JSON.stringify({
    checkedAt: new Date(now).toISOString(),
    loggedIn: true,
  }));
  await runLoginHealth({ home, notify: true, execImpl: mockExec, token: null, fetchImpl: async () => assert.fail('unexpected fetch'), now, io: mockIo });
  assert.equal(beds24Items()[0].status, 'dropped');

  // Run 4 (same failure recurs after recovery)
  fs.writeFileSync(path.join(home, '.claude', 'beds24-session-state.json'), JSON.stringify({
    checkedAt: new Date(now).toISOString(),
    loggedIn: false,
    needsHumanSince: new Date(now - 86400000).toISOString(),
  }));
  await runLoginHealth({ home, notify: true, execImpl: mockExec, token: null, fetchImpl: async () => assert.fail('unexpected fetch'), now, io: mockIo });
  assert.equal(beds24Items().length, 1);
  assert.equal(beds24Items()[0].status, 'open');
});

test('loginHealthSessionStart outputs summary line when failing items exist', () => {
  const home = createTestHome();
  const now = Date.now();

  fs.writeFileSync(path.join(home, '.claude', 'login-health.json'), JSON.stringify({
    results: [
      { id: 'codex', status: 'fail', detail: 'wsl_hung' },
      { id: 'browser:booking', status: 'fail', detail: 'booking 未ログイン', since: new Date(now - 10 * 86400000).toISOString() },
      { id: 'github', status: 'ok', detail: 'PAT有効' },
    ],
  }));

  const output = loginHealthSessionStart({ home });
  assert.equal(output, '🔑 ログイン切れ: codex(wsl_hung)・booking(10日) → node tools/login-health.mjs で直し方');

  fs.rmSync(home, { recursive: true, force: true });
});
