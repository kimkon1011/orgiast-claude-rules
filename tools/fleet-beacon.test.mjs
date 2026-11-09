import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBeacon } from './fleet-beacon.mjs';

test('optional 項目(mobile-standby)の NG もビーコンの failing に載る（fleet-status の「失敗:」欄）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'));
  const beacon = buildBeacon({ home, label: 'pc-1', identity: {}, pcMap: {}, results: [
    { item: { id: 'a', severity: 'required' }, status: 'OK' },
    { item: { id: 'mobile-standby', severity: 'optional' }, status: 'NG', reason: 'VSCode の痕跡あり but code.cmd 未検出' },
  ] });
  assert.deepEqual(beacon.failing.filter(id => id !== 'stuck-dialog-watch'), ['mobile-standby','production-sales-knowledge']);
  assert.equal(beacon.steps.find((s) => s.id === 'mobile-standby').status, 'fail');
  assert.match(beacon.steps.find((s) => s.id === 'mobile-standby').reason, /code\.cmd 未検出/);
});

test('knowledge beacon measures the actual delivered index',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-beacon-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const dir=path.join(home,'.claude','knowledge','production-sales');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'00_INDEX.md'),'制作');
 const beacon=buildBeacon({home,label:'WORK008'}), step=beacon.steps.find(s=>s.id==='production-sales-knowledge');
 assert.equal(step.status,'ok');assert.equal(step.reason,'00_INDEX.md 6 bytes');
});

import { buildInstallBeacon, sendInstallBeacon, fetchBeacons, main, INSTALL_BEACON_URL } from './fleet-beacon.mjs';

test('install beacon: fixed fields, account from home, no token, absent serial omitted', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'install-beacon-'));
  try {
    const beacon = buildInstallBeacon({ home, installer: 'sh-1' });
    assert.equal(beacon.kind, 'install-beacon');
    assert.equal(beacon.hostname, os.hostname());
    assert.equal(beacon.os, `${process.platform} ${os.release()}`);
    assert.equal(beacon.claudeAccount, '');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'installer@example.com' } }));
    assert.equal(buildInstallBeacon({ home, installer: 'sh-1' }).claudeAccount, 'installer@example.com');
    assert.equal('token' in beacon, false);
    if (process.platform !== 'darwin') assert.equal('serial' in beacon, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('install beacon: send follows redirect, accepts create/update and catches all failures', async () => {
  const beacon = { kind: 'install-beacon' };
  for (const action of ['created', 'updated']) {
    const result = await sendInstallBeacon(beacon, { url: 'https://example.invalid/test', fetchImpl: async (url, options) => {
      assert.equal(url, 'https://example.invalid/test');
      assert.equal(options.redirect, 'follow');
      assert.deepEqual(JSON.parse(options.body), beacon);
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ ok: true, action }) };
    } });
    assert.deepEqual(result, { ok: true, action });
  }
  for (const fetchImpl of [
    async () => ({ ok: false, status: 503 }),
    async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    async () => ({ ok: true, json: async () => ({ ok: false, error: 'full' }) }),
    async () => ({ ok: true, json: async () => ({ ok: true }) }),
  ]) assert.equal((await sendInstallBeacon(beacon, { fetchImpl })).ok, false);
});

test('install beacon CLI: one JSON line and proper exit code; environment URL override', async () => {
  const old = process.env.FLEET_INSTALL_BEACON_URL;
  process.env.FLEET_INSTALL_BEACON_URL = 'https://example.invalid/override';
  try {
    const lines = [];
    const deps = { home: os.tmpdir(), stdout: value => lines.push(value), fetch: async url => {
      assert.equal(url, process.env.FLEET_INSTALL_BEACON_URL);
      assert.notEqual(url, INSTALL_BEACON_URL);
      return { ok: true, json: async () => ({ ok: true, action: 'created' }) };
    } };
    assert.equal(await main(['--install-beacon', '--installer', 'sh-1'], deps), 0);
    assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).action, 'created');
    assert.equal(await main(['--install-beacon'], deps), 1);
    assert.equal(await main(['--install-beacon', '--installer', 'ps1-1'], { ...deps, fetch: async () => { throw new Error('offline'); } }), 1);
  } finally {
    if (old === undefined) delete process.env.FLEET_INSTALL_BEACON_URL;
    else process.env.FLEET_INSTALL_BEACON_URL = old;
  }
});

test('fetchBeacons: retries once on timeout, succeeds on second attempt', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('The operation was aborted due to timeout');
    return { ok: true, json: async () => ({ ok: true, beacons: [{ label: 'pc-1', steps: [], failing: [] }] }) };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-retry-ok-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
    const result = await fetchBeacons({ home, fetchImpl, retries: 1 });
    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
    assert.equal(result.beacons.length, 1);
    assert.equal(result.beacons[0].label, 'pc-1');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fetchBeacons: both attempts timeout returns ok=false', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    throw new TypeError('The operation was aborted due to timeout');
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-retry-fail-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
    const result = await fetchBeacons({ home, fetchImpl, retries: 1 });
    assert.equal(result.ok, false);
    assert.equal(attempts, 2);
    assert.ok(result.reason);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fetchBeacons: retries=0 (default) does not retry on timeout', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    throw new TypeError('The operation was aborted due to timeout');
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-noretry-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
    const result = await fetchBeacons({ home, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(attempts, 1);
    assert.ok(result.reason);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fetchBeacons: HTTP 500 does not retry', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return { ok: false, status: 500 };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-http-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
    const result = await fetchBeacons({ home, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(attempts, 1);
    assert.match(result.reason, /HTTP 500/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fetchBeacons: retries=1 retryDelayMs=0, 1st busy → 2nd success returns ok=true attempts=2', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    if (attempts === 1) return { ok: true, json: async () => ({ ok: false, error: 'busy' }) };
    return { ok: true, json: async () => ({ ok: true, beacons: [{ label: 'pc-1', steps: [], failing: [] }] }) };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-busy-ok-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
    const result = await fetchBeacons({ home, fetchImpl, retries: 1, retryDelayMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
    assert.equal(result.beacons.length, 1);
    assert.equal(result.beacons[0].label, 'pc-1');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fetchBeacons: retries=0, busy response returns ok=false with reason=busy, attempts=1', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return { ok: true, json: async () => ({ ok: false, error: 'busy' }) };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-busy-noretry-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
    const result = await fetchBeacons({ home, fetchImpl, retries: 0 });
    assert.equal(result.ok, false);
    assert.equal(attempts, 1);
    assert.match(result.reason, /busy/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fetchBeacons: non-busy error response (error:denied) does NOT retry even with retries>0', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return { ok: true, json: async () => ({ ok: false, error: 'denied' }) };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-denied-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
    const result = await fetchBeacons({ home, fetchImpl, retries: 2 });
    assert.equal(result.ok, false);
    assert.equal(attempts, 1);
    assert.match(result.reason, /denied/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fetchBeacons: FLEET_BEACON_FETCH_TIMEOUT_MS env var is respected', async () => {
  const old = process.env.FLEET_BEACON_FETCH_TIMEOUT_MS;
  process.env.FLEET_BEACON_FETCH_TIMEOUT_MS = '99999';
  try {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, beacons: [] }) });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-env-'));
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.com\nFLEET_SHEET_TOKEN=abc\n', 'utf8');
      const result = await fetchBeacons({ home, fetchImpl });
      assert.equal(result.ok, true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally {
    if (old === undefined) delete process.env.FLEET_BEACON_FETCH_TIMEOUT_MS;
    else process.env.FLEET_BEACON_FETCH_TIMEOUT_MS = old;
  }
});
