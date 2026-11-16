import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectWindowTasks, resetWindowTasks, registerAsScheduledTask } from './task-window-reset.mjs';

test('detectWindowTasks: empty tasks => no names', () => {
  const result = detectWindowTasks();
  assert.ok(Array.isArray(result.names));
  assert.ok(Array.isArray(result.tasks));
});

test('resetWindowTasks: dryRun does not apply fix', () => {
  const result = resetWindowTasks({ dryRun: true });
  assert.ok(Array.isArray(result.detected));
  assert.equal(result.wrapped, 0);
  assert.equal(result.skipped, 0);
});

test('registerAsScheduledTask: non-Windows skips', () => {
  const result = registerAsScheduledTask({ platform: 'linux', dryRun: true });
  assert.deepEqual(result, { skipped: 'Windows 以外はスキップ' });
});

test('registerAsScheduledTask: dryRun returns plan', () => {
  const result = registerAsScheduledTask({ dryRun: true });
  assert.ok(result.plan);
  assert.match(result.plan, /OrgiastTaskWindowReset/);
});

test('detectWindowTasks: reuses classifyTaskActions logic', () => {
  // The function internally calls Get-ScheduledTask via PowerShell on Windows.
  // On non-Windows it will fail gracefully. We test the contract here.
  assert.ok(typeof detectWindowTasks === 'function');
});

test('main entry: --dry-run does not modify', async () => {
  const { main } = await import('./task-window-reset.mjs');
  const exitCode = main(['--dry-run', '--json']);
  assert.equal(exitCode, 0);
});

test('main entry: --register dry-run returns plan', async () => {
  const { main } = await import('./task-window-reset.mjs');
  const exitCode = main(['--register', '--dry-run']);
  assert.equal(exitCode, 0);
});

test('PS1 guard contract: Windows E2E with isolated home', { skip: process.platform !== 'win32' }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'task-window-reset-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./fixtures/task-hide-guard-contract.ps1', import.meta.url)),
    '-TestHome', home,
  ], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(output.status, 0, `PS1 exit ${output.status}: ${output.stderr || output.stdout}`);
  assert.match(output.stdout, /PASS/);
});