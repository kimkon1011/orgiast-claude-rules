import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Windows registration: one indefinite watch trigger, logon unchanged, legacy repair and idempotence', { skip: process.platform !== 'win32' }, () => {
  const file = fileURLToPath(new URL('./register-reopen-lost-sessions.test.ps1', import.meta.url));
  // Fail if injection accidentally reaches the real scheduler. New-ScheduledTask*
  // only constructs in-memory definitions; all registration stays in the test map.
  const script = `function Register-ScheduledTask { throw 'Real scheduler writes prohibited in tests' }; & '${file.replaceAll("'", "''")}'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS: reopen task registration/);
});
