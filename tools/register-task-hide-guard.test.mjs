import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from './register-task-hide-guard.mjs';

test('dryRun builds hidden PS5.1 invocation without registering', () => {
  const plan = main({ dryRun: true, run() { assert.fail('dryRun must not register'); } });
  assert.equal(plan.file, 'powershell.exe');
  assert.deepEqual(plan.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.match(plan.args.at(-1), /register-task-hide-guard\.ps1$/);
  assert.equal(plan.options.windowsHide, true);
});
test('registration propagates errors and skips other platforms', () => {
  assert.equal(main({ platform: 'linux', run() { assert.fail(); } }), null);
  assert.throws(() => main({ platform: 'win32', run: () => ({ status: 1, stderr: 'denied' }) }), /denied/);
  assert.throws(() => main({ platform: 'win32', run: () => ({ error: Error('timeout') }) }), /timeout/);
});

test('PS5.1 guard and registration contracts with isolated home and scheduler mocks', { skip: process.platform !== 'win32' }, async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-hide-contract-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./fixtures/task-hide-guard-contract.ps1', import.meta.url)), '-TestHome', home], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.match(output, /PASS: guard exclusion/);
});
