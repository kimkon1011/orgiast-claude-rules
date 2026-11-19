import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rolloutMode } from './gate-runtime.mjs';
import { readConfig, runScheduler } from './meet-cue-scheduler.mjs';

const kimHosts = ['000KIMPC', '000KimPC', 'DESKTOP-2D0R4LI'];
const otherHost = 'DESKTOP-PPD5V8I';

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-hostname-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('Meet scheduler accepts current and former kim-PC hostnames, including legacy configurations', async t => {
  const home = temporaryHome(t);
  const config = { ...readConfig(home), enabled: false };
  assert.equal(config.seatHostname, 'kim-PC');
  for (const seatHostname of [config.seatHostname, 'DESKTOP-2D0R4LI']) {
    for (const hostname of kimHosts) {
      const result = await runScheduler({ home, hostname, config: { ...config, seatHostname } });
      assert.equal(result.skipped, 'disabled', `${seatHostname} / ${hostname}`);
    }
  }
  const result = await runScheduler({ home, hostname: otherHost, config });
  assert.equal(result.skipped, 'seat_hostname_mismatch');
});

test('configured kim-PC rollout applies to both hostnames and keeps another PC in observation', t => {
  const home = temporaryHome(t);
  const now = Date.parse('2026-11-19T00:00:00Z');
  for (const hostname of kimHosts) {
    assert.equal(rolloutMode('bg-turn-report-gate', { home, hostname, now }), 'deny', hostname);
  }
  assert.equal(rolloutMode('bg-turn-report-gate', { home, hostname: otherHost, now }), 'warn');
});

test('secretary installer reaches preflight only on kim-PC (Windows PowerShell)', { skip: process.platform !== 'win32' }, t => {
  const home = temporaryHome(t);
  const tools = path.join(home, 'tools');
  const payload = path.join(tools, 'secretary-progress');
  fs.mkdirSync(payload, { recursive: true });
  fs.copyFileSync(new URL('../fleet-pc-map.json', import.meta.url), path.join(home, 'fleet-pc-map.json'));
  const installer = path.join(tools, 'apply-secretary-progress.ps1');
  fs.copyFileSync(new URL('./apply-secretary-progress.ps1', import.meta.url), installer);
  // A missing fixture file with a required prior hash stops the installer before writes or restarts.
  fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify({
    files: [{ path: 'fixture.txt', before: 'a'.repeat(64), after: 'b'.repeat(64), previous: [] }],
  }));
  for (const [hostname, expected] of [
    ...kimHosts.map(host => [host, /Changed since review; refusing overwrite: fixture\.txt/]),
    [otherHost, /This deployment is scoped to kim-PC/],
    ['', /This deployment is scoped to kim-PC/],
  ]) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer], {
      env: { ...process.env, USERPROFILE: home, COMPUTERNAME: hostname },
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected, hostname);
  }
});
