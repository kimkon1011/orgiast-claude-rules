import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { detectEffortDowngrade, restoreEffortLevel } from './settings-quality-guard.mjs';

const settingsPath = path.join('/tmp', 'quality-guard-home', '.claude', 'settings.json');

test('medium / high は各ツールで警告も拒否も出さない', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-allowed-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file));
  for (const level of ['medium', 'high']) {
    fs.writeFileSync(file, JSON.stringify({ effortLevel: level }));
    assert.deepEqual(restoreEffortLevel(file), { changed: false });
    for (const tool_name of ['Edit', 'Write', 'MultiEdit', 'Bash', 'PowerShell']) {
      const text = `"effortLevel": "${level}"`;
      const tool_input = { file_path: file, new_string: text, content: `{${text}}`, edits: [{ new_string: text }], command: `node -e 'settings.json; ${text}'` };
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./settings-quality-guard.mjs', import.meta.url))], {
        input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_ALLOW_EFFORT_DOWNGRADE: '' },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '', `${tool_name}: ${level}`);
    }
  }
});

test('Edit は settings.json の許容外 effortLevel だけ block する', () => {
  assert.equal(detectEffortDowngrade('Edit', { file_path: settingsPath, new_string: '"effortLevel": "low"' }, settingsPath).blocked, true);
  assert.equal(detectEffortDowngrade('Edit', { file_path: settingsPath, new_string: '"effortLevel": "high"' }, settingsPath).blocked, false);
  assert.equal(detectEffortDowngrade('Edit', { file_path: '/tmp/other.json', new_string: '"effortLevel": "low"' }, settingsPath).blocked, false);
});

test('Bash による settings.json の low 化を block する', () => {
  const command = `sed -i 's/"effortLevel": "high"/"effortLevel": "low"/' settings.json`;
  assert.equal(detectEffortDowngrade('Bash', { command }, settingsPath).blocked, true);
});

test('lowからmedium/highへの修復はシェル経由でも拒否しない', () => {
  for (const level of ['medium', 'high']) {
    const command = `sed -i 's/"effortLevel": "low"/"effortLevel": "${level}"/' settings.json`;
    assert.equal(detectEffortDowngrade('Bash', { command }, settingsPath).blocked, false);
  }
  const command = '$s.effortLevel = "low"; $s | Set-Content settings.json';
  assert.equal(detectEffortDowngrade('PowerShell', { command }, settingsPath).blocked, true);
});

test('ORGIAST_ALLOW_EFFORT_DOWNGRADE=1 なら CLI は block しない', () => {
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: settingsPath, new_string: '"effortLevel": "low"' } });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./settings-quality-guard.mjs', import.meta.url))], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_ALLOW_EFFORT_DOWNGRADE: '1' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('restoreEffortLevel は low を退避して medium に復元する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const backups = path.join(root, 'backups');
  fs.writeFileSync(file, '{"effortLevel":"low","other":true}\n');
  const result = restoreEffortLevel(file, { now: 0, backupDir: backups });
  assert.deepEqual(result, { changed: true, from: 'low' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).effortLevel, 'medium');
  const backupFiles = fs.readdirSync(backups);
  assert.equal(backupFiles.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backups, backupFiles[0]), 'utf8')).effortLevel, 'low');
});

test('restoreEffortLevel は high を変更しない', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, '{"effortLevel":"high"}\n');
  assert.deepEqual(restoreEffortLevel(file, { now: 0, backupDir: path.join(root, 'backups') }), { changed: false });
});
