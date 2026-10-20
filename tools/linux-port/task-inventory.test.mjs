import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRegisterPs1, normalizeTime, inventory, toMarkdown } from './task-inventory.mjs';

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools'));
  return root;
};

test('normalizes 24h and 12h times', () => {
  assert.equal(normalizeTime('3', '00'), '03:00');
  assert.equal(normalizeTime('3', undefined, 'am'), '03:00');
  assert.equal(normalizeTime('12', '00', 'am'), '00:00');
  assert.equal(normalizeTime('12', '30', 'pm'), '12:30');
  assert.equal(normalizeTime('1', '05', 'pm'), '13:05');
  assert.throws(() => normalizeTime('13', '00', 'pm'), /Invalid 12-hour time/);
});

test('extracts names, times, repetition and targets', () => {
  const parsed = parseRegisterPs1(`
$taskName = 'OrgiastDecisionWatch'
$names = @('OrgiastAutoProgressWatch', 'OrgiastAutoProgressDigest')
$trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$repetition = New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 10)
$act = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-File', $nb, '-Target', 'tools\\nightly-batch.ps1')
Register-ScheduledTask -TaskName 'OrgiastNightlyBatch' -Action $act -Force
`);
  assert.deepEqual(parsed.taskNames, ['OrgiastAutoProgressDigest', 'OrgiastAutoProgressWatch', 'OrgiastDecisionWatch', 'OrgiastNightlyBatch']);
  assert.deepEqual(parsed.times, ['00:00', '09:00']);
  assert.deepEqual(parsed.everyMinutes, [10]);
  assert.deepEqual(parsed.targets, ['tools/nightly-batch.ps1']);
  assert.deepEqual(parsed.windowsOnly, { schtasks: 0, taskkill: 0, registry: 0 });
});

test('extracts hashtable definitions and ignores execution time limits', () => {
  const parsed = parseRegisterPs1(`
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 40)
$definitions = @(
  @{ Name = 'OrgiastRoleTester'; At = '04:10'; Description = 'x' },
  @{ Name = 'OrgiastRoleReview'; At = '04:30'; Description = 'y' }
)
$specs = @(
  [pscustomobject]@{ TaskName = 'OrgiastMorningBatch'; ScriptName = 'open-work.mjs' }
)
`);
  assert.deepEqual(parsed.taskNames, ['OrgiastMorningBatch', 'OrgiastRoleReview', 'OrgiastRoleTester']);
  assert.deepEqual(parsed.times, ['04:10', '04:30']);
  assert.deepEqual(parsed.everyMinutes, []);
  assert.deepEqual(parsed.targets, ['tools/open-work.mjs']);
});

test('counts windows-only calls without matching unrelated words', () => {
  const parsed = parseRegisterPs1('schtasks /Create\nStart-Process taskkill\nreg query HKLM');
  assert.equal(parsed.windowsOnly.schtasks, 1);
  assert.equal(parsed.windowsOnly.taskkill, 1);
  assert.equal(parsed.windowsOnly.registry, 1);
});

test('inventory reports mjs coverage and unparsed scripts', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'tools', 'register-a.ps1'), "Register-ScheduledTask -TaskName 'TaskA' -At '03:00'");
  fs.writeFileSync(path.join(root, 'tools', 'register-a.mjs'), '');
  fs.writeFileSync(path.join(root, 'tools', 'register-b.ps1'), '# no task here');
  const result = inventory(root);
  assert.equal(result.ps1Total, 2);
  assert.equal(result.parsedTaskTotal, 1);
  assert.equal(result.filesWithMjs, 1);
  assert.deepEqual(result.filesWithoutTaskName, ['register-b.ps1']);
  assert.match(toMarkdown(result), /register-b\.ps1/);
});

test('inventory refuses to report success when nothing is measured', t => {
  const root = fixture(t);
  assert.throws(() => inventory(root), /measurement impossible/);
});
