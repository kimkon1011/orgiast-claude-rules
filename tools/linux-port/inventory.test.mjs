import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectInventory, increases } from './inventory.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, 'register-demo.ps1'), 'Start-Process node\ntaskkill /F\n');
  fs.writeFileSync(path.join(root, 'helper.ps1'), 'Get-ItemProperty x\nschtasks /Query\nreg query HKCU\n');
  fs.writeFileSync(path.join(root, 'paths.txt'), 'C:\\Users\\demo C:/Users/demo\nH:\\demo\n');
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'pwsh foo.ps1' }, { type: 'command', command: 'node foo.mjs' }, { type: 'command', command: 'powershell foo.ps1' }] }] } }));
  return root;
}
test('fixture counts files, path lines, hook definitions and calls', t => {
  const root = fixture(t);
  const result = collectInventory(root);
  assert.deepEqual(result, {
    ps1Total: 2, registerPs1Total: 1, hooksTotal: 3, pwshHooksTotal: 2,
    hardcodedPathFiles: 1, hardcodedPathLines: 2,
    windowsOnlyCalls: { taskkill: 1, schtasks: 1, 'reg query': 1, 'Get-ItemProperty': 1, 'Start-Process': 1 },
  });
  fs.mkdirSync(path.join(root, 'reports'));
  fs.writeFileSync(path.join(root, 'reports', 'linux-port-inventory.md'), 'C:\\Users\\demo\nschtasks');
  assert.deepEqual(collectInventory(root), result);
  fs.writeFileSync(path.join(root, 'unicode.ps1'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Start-Process node', 'utf16le')]));
  assert.equal(collectInventory(root).windowsOnlyCalls['Start-Process'], 2);
});
test('ratchet detects individual increases even if another count falls', t => {
  const baseline = collectInventory(fixture(t));
  assert.deepEqual(increases(baseline, baseline), []);
  const improved = { ...baseline, ps1Total: 1 };
  assert.deepEqual(increases(improved, baseline), []);
  assert.deepEqual(increases({ ...improved, pwshHooksTotal: 3 }, baseline), ['pwshHooksTotal: 2 -> 3']);
  assert.deepEqual(increases({ ...baseline, windowsOnlyCalls: { ...baseline.windowsOnlyCalls, taskkill: 2 } }, baseline), ['windowsOnlyCalls.taskkill: 1 -> 2']);
});
test('CLI writes deterministic reports and enforces the saved baseline', t => {
  const root = fixture(t);
  const script = fileURLToPath(new URL('./inventory.mjs', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  const json = invoke('--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), collectInventory(root));
  const initial = invoke('--check');
  assert.equal(initial.status, 0, initial.stderr);
  const reports = invoke();
  assert.equal(reports.status, 0, reports.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'reports', 'linux-port-inventory.json'), 'utf8')), collectInventory(root));
  assert.match(fs.readFileSync(path.join(root, 'reports', 'linux-port-inventory.md'), 'utf8'), /差分/);
  assert.equal(invoke('--check').status, 0);
  fs.writeFileSync(path.join(root, 'extra.ps1'), 'taskkill /F');
  const regression = invoke('--check');
  assert.equal(regression.status, 1);
  assert.match(regression.stderr, /ps1Total: 2 -> 3/);
  assert.match(regression.stderr, /windowsOnlyCalls.taskkill: 1 -> 2/);
});
