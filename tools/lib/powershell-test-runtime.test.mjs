import test from 'node:test';
import assert from 'node:assert/strict';
import { powerShellTestRuntime } from '../fixtures/powershell-test-runtime.mjs';

test('Windows always runs PowerShell tests; WSL requires script output, not just exit zero', () => {
  assert.equal(powerShellTestRuntime('powershell.exe', { platform: 'win32', spawn() { assert.fail('Windows must not skip based on probing'); } }), true);
  for (const result of [{ status: 0, stdout: '' }, { status: null, error: { code: 'ETIMEDOUT' } }, { status: 1, stdout: 'orgiast-powershell-test-ready' }]) {
    assert.equal(powerShellTestRuntime('powershell.exe', { platform: 'linux', spawn: () => result }), false);
  }
  assert.equal(powerShellTestRuntime('pwsh', { platform: 'linux', spawn: (_shell, args, options) => {
    assert.ok(args.includes('-EncodedCommand')); assert.equal(options.timeout, 3000);
    return { status: 0, stdout: 'orgiast-powershell-test-ready\n' };
  } }), true);
});
