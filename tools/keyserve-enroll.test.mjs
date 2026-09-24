import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, buildInstallCommand } from './keyserve-enroll.mjs';

function fixture(t, primary = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyserve-enroll-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  if (primary) fs.writeFileSync(path.join(home, '.claude', 'keyserve.env'), 'ORGIAST_KEYSERVE_SECRET=primary-test\n');
  const output = [], errors = [];
  return { home, output, errors, stdout: (s) => output.push(s), stderr: (s) => errors.push(s) };
}
const token = 'ORG1.opaque-server-value.signature';
const response = () => new Response(JSON.stringify({ token, pc: '日本語 PC', expiresAt: 1234567890, ttlHours: 24 }));

test('CLI exits 1 without a primary file, even with legacy/enroll/env credentials', (t) => {
  const f = fixture(t, false);
  fs.writeFileSync(path.join(f.home, '.claude', 'cost-reporter.env'), 'DISCORD_COST_WEBHOOK=legacy\n');
  fs.writeFileSync(path.join(f.home, '.claude', 'enroll.env'), 'ORGIAST_ENROLL_TOKEN=token\n');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./keyserve-enroll.mjs', import.meta.url)), '--pc', 'PC', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_KEYSERVE_SECRET: 'must-not-use-env' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /primary を持つ別PC/);
  assert.equal(result.stdout, '');
});
test('--dry-run constructs a full command without issuing or sending', async (t) => {
  const f = fixture(t);
  assert.equal(await main(['--pc', '日本語 PC', '--dry-run', '--dm'], { ...f,
    fetchImpl: () => assert.fail('must not issue'), notify: () => assert.fail('must not send'),
  }), 0);
  assert.match(f.output[0], /install-orgiast.ps1/);
  assert.match(f.output[0], /-Enroll 'DRY_RUN_TOKEN_NOT_VALID'/);
  assert.match(f.output[0], /スタート.*Windowsマーク/);
  assert.match(f.output[0], /右クリック.*Enter/);
});
test('issuance signs timestamp with primary and raw token appears only inside the command', async (t) => {
  const f = fixture(t);
  let calls = 0;
  assert.equal(await main(['--pc', '日本語 PC', '--ttl-hours', '12'], { ...f, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://orgiast-keyserve.vercel.app/api/enroll');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { pc: '日本語 PC', ttlHours: 12 });
    assert.equal(options.headers['x-orgiast-auth'], crypto.createHmac('sha256', 'primary-test').update(options.headers['x-orgiast-ts']).digest('hex'));
    assert.equal(options.headers['x-orgiast-enroll'], undefined);
    return response();
  } }), 0);
  assert.equal(calls, 1);
  const lines = f.output[0].split('\n');
  assert.equal(lines.filter((line) => line.includes(token)).length, 1);
  assert.match(lines.find((line) => line.includes(token)), /-Enroll /);
  assert.match(f.output[0], new RegExp(`SHA-256: ${crypto.createHash('sha256').update(token).digest('hex').slice(0, 10)}`));
  assert.ok(!f.output[0].includes('primary-test'));
  assert.equal(f.errors.length, 0);
});
test('--json includes token and executable command', async (t) => {
  const f = fixture(t);
  assert.equal(await main(['--pc', 'PC', '--json'], { ...f, fetchImpl: async () => response() }), 0);
  const value = JSON.parse(f.output[0]);
  assert.equal(value.token, token);
  assert.equal(value.command, buildInstallCommand(token));
});
test('--dm reuses notifyKim without exposing the command to webhook fallback', async (t) => {
  const f = fixture(t);
  let sent = 0;
  assert.equal(await main(['--pc', 'PC', '--dm'], { ...f, fetchImpl: async () => response(), notify: async (text, options) => {
    sent++;
    assert.match(text, /スタート/);
    assert.match(text, /-Enroll /);
    assert.ok(text.length <= 2000);
    assert.equal(options.webhookFallback, false);
    return { delivered: 'dm' };
  } }), 0);
  assert.equal(sent, 1);
});
test('server and network errors never echo response secrets', async (t) => {
  for (const fetchImpl of [async () => new Response(`secret ${token}`, { status: 401 }), async () => { throw new Error(token); }]) {
    const f = fixture(t);
    assert.equal(await main(['--pc', 'PC'], { ...f, fetchImpl }), 1);
    assert.ok(!f.errors.join('').includes(token));
    assert.equal(f.output.length, 0);
  }
});
test('PowerShell literal escaping preserves opaque tokens and rejects newlines', () => {
  assert.ok(buildInstallCommand("opaque'$();value").includes("-Enroll 'opaque''$();value'"));
  assert.throws(() => buildInstallCommand('a\nb'));
});
