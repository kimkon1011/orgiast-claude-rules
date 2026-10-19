import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { countHooks } from './check-hooks.mjs';

const script = fileURLToPath(new URL('./check-hooks.mjs', import.meta.url));
function fixture(t, hooks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks }));
  return file;
}
function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('countHooks counts command hooks and PowerShell dependence', () => {
  const result = countHooks({ hooks: {
    SessionStart: [{ hooks: [{ command: 'node a.mjs' }, { command: 'pwsh -File b.ps1' }] }],
    Stop: [{ hooks: [{ command: 'powershell -NoProfile -File c.ps1' }] }],
  } });
  assert.deepEqual(result, { total: 3, pwshDependent: 2 });
});

test('linux requires zero pwsh-dependent hooks', t => {
  const clean = run('--platform', 'linux', '--settings', fixture(t, { SessionStart: [{ hooks: [{ command: 'node a.mjs' }] }] }));
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /pwsh-dependent hooks: 0/);

  const dirty = run('--platform', 'linux', '--settings', fixture(t, { SessionStart: [{ hooks: [{ command: 'pwsh -File a.ps1' }] }] }));
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /PowerShell 依存が 1 件/);
});

test('win32 keeps accepting PowerShell hooks (no regression)', t => {
  const win = run('--platform', 'win32', '--settings', fixture(t, { SessionStart: [{ hooks: [{ command: 'pwsh -File a.ps1' }] }] }));
  assert.equal(win.status, 0, win.stderr);
  assert.match(win.stdout, /pwsh-dependent hooks: 1/);
});

test('generated distribution set for linux has no PowerShell hooks', () => {
  const result = run('--platform', 'linux');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /hook total: [1-9]\d*/);
  assert.match(result.stdout, /pwsh-dependent hooks: 0/);
});
