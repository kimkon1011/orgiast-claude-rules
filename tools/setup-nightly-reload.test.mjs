import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convergeNightlyReload, ensureRestoreWindows } from './setup-nightly-reload.mjs';

test('non-Windows does not touch settings or scheduler', () => {
  assert.equal(convergeNightlyReload({ platform: 'linux', run() { assert.fail(); }, restore() { assert.fail(); } }).status, 'NOTICE');
});
test('registration reports change, no-op, and errors without starting the task', () => {
  for (const changed of [true, false]) {
    const result = convergeNightlyReload({ platform: 'win32', restore: () => false, run(command, args, options) {
      assert.equal(command, 'powershell.exe');
      assert.equal(args.at(-1).endsWith('register-nightly-reload-vscode.ps1'), true);
      assert.equal(options.windowsHide, true);
      return JSON.stringify({ changed });
    } });
    assert.equal(result.status, 'OK');
    assert.equal(result.repaired, changed);
  }
  assert.equal(convergeNightlyReload({ platform: 'win32', restore: () => false, run: () => '{}' }).status, 'NG');
  assert.equal(convergeNightlyReload({ platform: 'win32', restore() { throw Error('invalid settings'); }, run() { assert.fail(); } }).status, 'NG');
  assert.equal(convergeNightlyReload({ platform: 'win32', restore: () => false, run() { throw Error('access denied'); } }).status, 'NG');
});
test('restoreWindows preserves JSONC and is idempotent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  for (const source of ['{}', '{\n// comment\n"editor.fontSize": 14,\n}', '{"window.restoreWindows": "none", "url": "https://example.com"}', '\uFEFF{/* comment */}']) {
    fs.writeFileSync(file, source);
    assert.equal(ensureRestoreWindows(file), true);
    const first = fs.readFileSync(file, 'utf8');
    assert.match(first, /"window.restoreWindows"\s*:\s*"all"/);
    assert.equal(ensureRestoreWindows(file), false);
    assert.equal(fs.readFileSync(file, 'utf8'), first);
    if (source.includes('comment')) assert.match(first, /comment/);
  }
  fs.writeFileSync(file, '{broken');
  assert.throws(() => ensureRestoreWindows(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
