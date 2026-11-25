import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { deploySkills } from './onboarding-sync.mjs';

const repo = path.resolve(import.meta.dirname, '..');
test('new and existing PC skill deployment preserves unrelated local skills and is idempotent', (t) => {
  for (const existing of [false, true]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-distribution-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const root = path.join(home, '.claude', 'skills');
    if (existing) {
      fs.mkdirSync(path.join(root, 'personal-skill'), { recursive: true });
      fs.writeFileSync(path.join(root, 'personal-skill', 'SKILL.md'), 'leave intact');
    }
    assert.ok(deploySkills(repo, home, { quiet: true }).includes('autopilot'));
    assert.equal(fs.readFileSync(path.join(root, 'autopilot', 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(repo, 'skills', 'autopilot', 'SKILL.md'), 'utf8'));
    assert.deepEqual(deploySkills(repo, home, { quiet: true }), []);
    if (existing) assert.equal(fs.readFileSync(path.join(root, 'personal-skill', 'SKILL.md'), 'utf8'), 'leave intact');
  }
});

test('setup manifest recognizes both repo locations and deployed skill; repair stays onboarding-sync', (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'setup-manifest.json'), 'utf8'));
  const items = manifest.items.filter((i) => ['tool:autopilot-tick', 'skill:autopilot'].includes(i.id));
  assert.equal(items.length, 2);
  for (const item of items) assert.deepEqual(item.repair, ['onboarding-sync.mjs', '--force']);
  for (const location of ['orgiast-claude-rules', 'Downloads/orgiast-claude-rules']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-manifest-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, location, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'tools', 'autopilot-tick.mjs'), path.join(home, location, 'tools', 'autopilot-tick.mjs'));
    deploySkills(repo, home, { quiet: true });
    const file = path.join(home, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, items }));
    const result = spawnSync(process.execPath, [path.join(repo, 'tools', 'setup.mjs'), '--home', home, '--manifest', file, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).items.every((i) => i.status === 'OK'));
  }
});

test('task registration is opt-in, hidden, every 30 minutes, and rejects overlaps', () => {
  const script = fs.readFileSync(path.join(repo, 'tools', 'register-autopilot-task.ps1'), 'utf8');
  assert.match(script, /New-HiddenScheduledTaskAction/);
  assert.match(script, /RepetitionInterval \(New-TimeSpan -Minutes 30\)/);
  assert.match(script, /MultipleInstances IgnoreNew/);
  assert.match(script, /TaskName 'OrgiastAutopilot'/);
  assert.ok(!script.startsWith('\uFEFF'));
  for (const name of ['onboarding-sync.mjs', 'fleet-poller.ps1', 'install-orgiast.ps1']) assert.ok(!fs.readFileSync(path.join(repo, 'tools', name), 'utf8').includes('register-autopilot-task.ps1'));
});
