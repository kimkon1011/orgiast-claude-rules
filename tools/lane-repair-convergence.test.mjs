import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main as registerTask } from './register-rule-compliance-task.mjs';
import { runAndPersist } from './run-rule-compliance-loop.mjs';
import { sessionLaneHealth } from './sessionstart-lane-health.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url)));
function homeFor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-converge-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  return home;
}
test('Windows registrar uses existing per-user daily --apply wrapper', () => {
  let called;
  assert.equal(registerTask({ platform: 'win32', spawnImpl: (cmd, args, options) => { called = { cmd, args, options }; return { status: 0, stdout: 'registered' }; } }), 0);
  assert.equal(called.cmd, 'powershell.exe');
  assert.ok(called.args.at(-1).endsWith('register-rule-compliance-task.ps1'));
  const ps = fs.readFileSync(new URL('./register-rule-compliance-task.ps1', import.meta.url), 'utf8');
  assert.match(ps, /New-ScheduledTaskTrigger -Daily/);
  assert.match(ps, /run-rule-compliance-loop\.mjs/);
  assert.match(ps, /-UserId/);
});
test('daily wrapper creates enforcement with validated new rule and preserves existing rules', t => {
  const home = homeFor(t);
  const result = runAndPersist({ home });
  const state = JSON.parse(fs.readFileSync(path.join(home, '.claude/rule-enforcement.json')));
  assert.equal(state['repair-failed-lane-first'].mode, 'warn');
  assert.equal(state['repair-failed-lane-first'].precision, 1);
  assert.ok(state['handoff-quality-only']);
  assert.ok(result.report.includes('repair-failed-lane-first'));
});
test('converge wires synchronous gate through runner; repeated registration is idempotent', t => {
  const home = homeFor(t);
  const selected = manifest.items.filter(i => ['settings:lane-repair-first', 'settings:lane-health-SessionStart', 'state:rule-enforcement'].includes(i.id));
  const file = path.join(home, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: selected }));
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  const result = spawnSync(process.execPath, [path.join(repo, 'tools/setup.mjs'), '--converge', '--manifest', file, '--home', home, '--json'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const checks = JSON.parse(result.stdout);
  for (const id of selected.map(x => x.id)) assert.equal(checks.items.find(x => x.id === id)?.status, 'OK', id);
  const registered = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json')));
  const gate = registered.hooks.PreToolUse.filter(group => group.hooks.some(h => h.command.includes('lane-repair-first-gate.mjs')));
  assert.equal(gate.length, 1);
  assert.match(gate[0].matcher, /NotebookEdit/);
  assert.match(gate[0].hooks[0].command, /gate-hook-runner.mjs/);
  assert.notEqual(gate[0].hooks[0].async, true);
  const again = spawnSync(process.execPath, [path.join(repo, 'tools/register-hooks.mjs'), '--hooks-only'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(again.status, 0, again.stderr);
  const repeated = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json')));
  assert.equal(repeated.hooks.PreToolUse.filter(g => g.hooks.some(h => h.command.includes('lane-repair-first-gate.mjs'))).length, 1);
});
test('SessionStart states repair-first and quota alternatives', t => {
  const home = homeFor(t), now = Date.now();
  fs.writeFileSync(path.join(home, '.claude/openrouter.env'), 'OPENROUTER_API_KEY=fixture-only');
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify({ lanes: { deepseek: { alive: false, reason: 'auth_invalid', probedAt: new Date(now).toISOString() } } }));
  const output = sessionLaneHealth({ home, now, auditLaunch: () => false });
  assert.match(output.hookSpecificOutput.additionalContext, /本セッションの最初の作業はレーン修復:.*deepseek/);
});
