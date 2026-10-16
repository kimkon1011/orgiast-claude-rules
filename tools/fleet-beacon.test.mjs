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
  assert.deepEqual(beacon.failing.filter(id => id !== 'stuck-dialog-watch'), ['mobile-standby']);
  assert.equal(beacon.steps.find((s) => s.id === 'mobile-standby').status, 'fail');
  assert.match(beacon.steps.find((s) => s.id === 'mobile-standby').reason, /code\.cmd 未検出/);
});

import { buildInstallBeacon, sendInstallBeacon, main, INSTALL_BEACON_URL } from './fleet-beacon.mjs';

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
