import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { detectEffortDowngrade, restoreEffortLevel } from './settings-quality-guard.mjs';

const settingsPath = path.join('/tmp', 'quality-guard-home', '.claude', 'settings.json');

test('Edit は settings.json の許容外 effortLevel だけ block する', () => {
  assert.equal(detectEffortDowngrade('Edit', { file_path: settingsPath, new_string: '"effortLevel": "medium"' }, settingsPath).blocked, true);
  assert.equal(detectEffortDowngrade('Edit', { file_path: settingsPath, new_string: '"effortLevel": "high"' }, settingsPath).blocked, false);
  assert.equal(detectEffortDowngrade('Edit', { file_path: '/tmp/other.json', new_string: '"effortLevel": "medium"' }, settingsPath).blocked, false);
});

test('Bash による settings.json の medium 化を block する', () => {
  const command = `sed -i 's/"effortLevel": "high"/"effortLevel": "medium"/' settings.json`;
  assert.equal(detectEffortDowngrade('Bash', { command }, settingsPath).blocked, true);
});

test('ORGIAST_ALLOW_EFFORT_DOWNGRADE=1 なら CLI は block しない', () => {
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: settingsPath, new_string: '"effortLevel": "medium"' } });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./settings-quality-guard.mjs', import.meta.url))], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_ALLOW_EFFORT_DOWNGRADE: '1' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('restoreEffortLevel は medium を退避して high に復元する', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const backups = path.join(root, 'backups');
  fs.writeFileSync(file, '{"effortLevel":"medium","other":true}\n');
  const result = restoreEffortLevel(file, { now: 0, backupDir: backups });
  assert.deepEqual(result, { changed: true, from: 'medium' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).effortLevel, 'high');
  const backupFiles = fs.readdirSync(backups);
  assert.equal(backupFiles.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backups, backupFiles[0]), 'utf8')).effortLevel, 'medium');
});

test('restoreEffortLevel は high を変更しない', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, '{"effortLevel":"high"}\n');
  assert.deepEqual(restoreEffortLevel(file, { now: 0, backupDir: path.join(root, 'backups') }), { changed: false });
});
