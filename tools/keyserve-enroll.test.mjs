import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-enroll-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  const token = crypto.randomBytes(24).toString('hex');
  const primary = crypto.randomBytes(24).toString('hex');
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  const exists = (name) => fs.existsSync(path.join(dir, name));
  const preload = path.join(home, 'mock-keyserve.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const env = process.env;
const realWrite = fs.writeFileSync;
if (env.TEST_WRITE_FAIL) fs.writeFileSync = function(file, ...args) {
  if (path.basename(file) === 'keyserve.env') throw new Error('injected write failure');
  return realWrite.call(this, file, ...args);
};
globalThis.fetch = async (url, options) => {
  if (url !== 'https://keyserve.invalid/keys') throw new Error('external network disabled');
  const expected = crypto.createHmac('sha256', env.TEST_EXPECTED).update(options.headers['x-orgiast-ts']).digest('hex');
  if (options.method !== 'POST' || options.headers['x-orgiast-auth'] !== expected) return new Response('', { status: 401 });
  if (env.TEST_MODE === '401') return new Response('', { status: 401 });
  if (env.TEST_MODE === 'malformed') return new Response(env.TEST_PRIMARY, { status: 200 });
  const files = env.TEST_MODE === 'empty' ? {} : env.TEST_MODE === 'invalid-key' ? { 'keyserve.env': '' } : {
    'keyserve.env': 'ORGIAST_KEYSERVE_SECRET=' + env.TEST_PRIMARY + '\\n',
    'fleet-sheet.env': 'FLEET_SHEET_URL=https://fleet.invalid/report\\nFLEET_SHEET_TOKEN=' + env.TEST_PRIMARY + '\\n',
  };
  return new Response(JSON.stringify({ files }), { status: 200 });
};
`);
  const run = (script = 'onboarding-sync.mjs', extraEnv = {}, scriptArgs = script === 'onboarding-sync.mjs' ? ['--keys-only', '--force'] : ['--json']) => spawnSync(process.execPath, [
    '--import', pathToFileURL(preload).href, path.join(toolsDir, script), ...scriptArgs,
  ], { encoding: 'utf8', timeout: 15000, env: {
    ...process.env, ORGIAST_HOME: home, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_ENROLL_TOKEN: '',
    ORGIAST_KEYSERVE_URL: 'https://keyserve.invalid/keys', TEST_EXPECTED: token, TEST_PRIMARY: primary, ...extraEnv,
  } });
  return { home, dir, token, primary, write, read, exists, run, preload };
}

test('enroll token bootstraps a fresh PC and is removed immediately after primary is saved', (t) => {
  const f = fixture(t);
  f.write('enroll.env', `ORGIAST_ENROLL_TOKEN=${f.token}\n`);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(f.read('keyserve.env').includes(f.primary));
  assert.ok(f.exists('fleet-sheet.env'));
  assert.equal(f.exists('enroll.env'), false);
  assert.equal(r.stderr.trim(), 'enroll token を使用中（初回登録）');
  const second = f.run('onboarding-sync.mjs', { TEST_EXPECTED: f.primary });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
});

test('existing PC with label-only reporter, old settings and no keys upgrades using enroll environment', (t) => {
  const f = fixture(t);
  f.write('cost-reporter.env', 'REPORTER_LABEL=existing-pc\n');
  f.write('settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'onboarding-sync.ps1' }] }] } }));
  const before = f.read('settings.json');
  const r = f.run('onboarding-sync.mjs', { ORGIAST_ENROLL_TOKEN: f.token });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(f.exists('keyserve.env'));
  assert.ok(f.exists('fleet-sheet.env'));
  assert.equal(f.read('settings.json'), before);
  assert.equal(f.read('cost-reporter.env'), 'REPORTER_LABEL=existing-pc\n');
});

test('received unchanged or rotated primary removes leftover enroll token on existing PC', (t) => {
  for (const same of [true, false]) {
    const f = fixture(t);
    f.write('enroll.env', `ORGIAST_ENROLL_TOKEN=${f.token}\n`);
    const previous = same ? f.primary : crypto.randomBytes(24).toString('hex');
    f.write('keyserve.env', `ORGIAST_KEYSERVE_SECRET=${previous}\n`);
    const r = f.run('onboarding-sync.mjs', { TEST_EXPECTED: previous });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(f.read('keyserve.env').includes(f.primary));
    assert.equal(f.exists('enroll.env'), false);
  }
});

test('failed authentication, invalid response, absent primary and failed write retain enroll token', (t) => {
  for (const extra of [{ TEST_MODE: '401' }, { TEST_MODE: 'malformed' }, { TEST_MODE: 'empty' }, { TEST_MODE: 'invalid-key' }, { TEST_WRITE_FAIL: '1' }]) {
    const f = fixture(t);
    f.write('enroll.env', `ORGIAST_ENROLL_TOKEN=${f.token}\n`);
    const r = f.run('onboarding-sync.mjs', extra);
    assert.equal(r.status, 0);
    assert.equal(f.exists('enroll.env'), true);
  }
});

test('enroll deletion failure warns once and still distributes subsequent keys', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'enroll.env'));
  const r = f.run('onboarding-sync.mjs', { ORGIAST_ENROLL_TOKEN: f.token });
  assert.equal(r.status, 0);
  assert.ok(f.exists('keyserve.env'));
  assert.ok(f.exists('fleet-sheet.env'));
  assert.equal(r.stderr.split('\n').filter((line) => line.includes('削除に失敗')).length, 1);
});

test('both clients report missing secret as one stderr line without making a request', (t) => {
  const f = fixture(t);
  for (const script of ['onboarding-sync.mjs', 'keyserve-status.mjs']) {
    const r = f.run(script);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), 'keyserve に認証する秘密がありません（配布コマンドに -EnrollToken が無い）');
    if (script === 'keyserve-status.mjs') assert.equal(JSON.parse(r.stdout).auth, 'none');
  }
});

test('secret values never appear in client stdout, stderr or sync logs (success, 401, malformed response)', (t) => {
  for (const script of ['onboarding-sync.mjs', 'keyserve-status.mjs']) {
    for (const mode of ['', '401', 'malformed']) {
      const f = fixture(t);
      f.write('enroll.env', `ORGIAST_ENROLL_TOKEN=${f.token}\n`);
      const r = f.run(script, { TEST_MODE: mode });
      assert.equal(r.status, 0);
      const log = f.exists('hooks/onboarding-sync.log') ? f.read('hooks/onboarding-sync.log') : '';
      for (const value of [f.token, f.primary]) assert.ok(!(r.stdout + r.stderr + log).includes(value), 'credential must not be logged');
      if (script === 'keyserve-status.mjs') {
        const result = JSON.parse(r.stdout);
        assert.equal(result.auth, 'enroll');
        assert.equal(result.success, !mode);
        assert.equal(f.exists('enroll.env'), true, 'status does not save primary or delete enrollment');
      }
    }
  }
});

test('setup --converge repairs required primary through its actual keys-only child process', (t) => {
  const f = fixture(t);
  f.write('enroll.env', `ORGIAST_ENROLL_TOKEN=${f.token}\n`);
  f.write('cost-reporter.env', 'REPORTER_LABEL=existing-pc\n');
  const entry = JSON.parse(fs.readFileSync(path.join(toolsDir, 'setup-manifest.json'), 'utf8')).items.find((i) => i.id === 'env:keyserve');
  const manifest = path.join(f.home, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, items: [entry] }));
  const r = f.run('setup.mjs', { NODE_OPTIONS: `--import=${pathToFileURL(f.preload).href}` }, [
    '--converge', '--strict', '--json', '--home', f.home, '--manifest', manifest,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).items[0], { id: 'env:keyserve', severity: 'required', status: 'OK', checked: true, repaired: true });
  assert.ok(f.exists('fleet-sheet.env'));
  assert.equal(f.exists('enroll.env'), false);
});
