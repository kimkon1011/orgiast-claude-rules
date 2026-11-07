import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./register-nightly-tools.ps1', import.meta.url), 'utf8');

test('existing batch tasks are extended and only the independent health task is registered', () => {
  const registrations = [...source.matchAll(/Register-ScheduledTask -TaskName '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(registrations, ['OrgiastNightlyHealth']);
  assert.match(source, /Set-ScheduledTask[\s\S]*-Action\s*\(@\(\$task\.Actions\)\s*\+\s*\$newAction\)/i);
});

test('dry-run and removal switches are part of the contract', () => {
  assert.match(source, /\[switch\]\$DryRun\b/);
  assert.match(source, /\[switch\]\$Remove\b/);
});

test('all three nightly scripts are wired', () => {
  for (const script of ['next-actions.mjs', 'nightly-health.mjs', 'pricing-brief.mjs', 'drive-hub-mirror.mjs']) {
    assert.ok(source.includes(script), `${script} is missing`);
  }
});

test('changes are read back and machine-specific paths are absent', () => {
  const reads = source.match(/Get-ScheduledTask\s+-TaskName/g) || [];
  assert.ok(reads.length >= 2, 'expected an initial read and a read-back');
  assert.match(source, /Read back from Task Scheduler/);
  assert.match(source, /\$PSScriptRoot/);
  assert.doesNotMatch(source, /C:\\Users\\uers/i);
});

test('remediation is removed from morning specs and has a separate hidden 90-minute task', () => {
  const specs = source.slice(source.indexOf('$specs = @('), source.indexOf(". (Join-Path $PSScriptRoot"));
  assert.doesNotMatch(specs, /nightly-health-remediate/);
  assert.match(source, /legacyPattern/);
  assert.match(source, /if \(-not \$DryRun\) \{\s+Set-ScheduledTask -TaskName 'OrgiastMorningBatch' -Action \$kept/);
  const registration = fs.readFileSync(new URL('./register-nightly-remediate-task.ps1', import.meta.url), 'utf8');
  assert.match(registration, /-At 7:20am/);
  assert.match(registration, /-Minutes 90/);
  assert.match(registration, /New-HiddenScheduledTaskAction/);
  assert.match(registration, /OrgiastNightlyRemediate/);
  assert.doesNotMatch(registration, /[^\x00-\x7f]/);
});

test('health has an independent hidden daily budget while open-work stays in morning', () => {
  const specs = source.slice(source.indexOf('$specs = @('), source.indexOf(". (Join-Path $PSScriptRoot"));
  assert.doesNotMatch(specs, /nightly-health\.mjs/);
  assert.match(specs, /TaskName = 'OrgiastMorningBatch'; ScriptName = 'open-work.mjs'/);
  assert.match(source, /New-ScheduledTaskTrigger -Daily -At '07:10'/);
  assert.match(source, /\$healthSettings.ExecutionTimeLimit = 'PT30M'/);
  assert.match(source, /CimInstance\]::new\(\$morning.Settings\)/);
  assert.match(source, /-Principal \$morning.Principal -Settings \$healthSettings/);
  assert.match(source, /\$healthArguments = .*Quote-TaskArgument \$runHidden/);
  assert.match(source, /New-ScheduledTaskAction -Execute \$wscript -Argument \$healthArguments -WorkingDirectory \$repo/);
  assert.doesNotMatch(source, /[^\x00-\x7f]/);
});

test('health migration verifies replacement before removing the old action and supports dry-run', () => {
  const block = source.slice(source.indexOf('# Health needs its own budget'), source.indexOf('# Converge old installations'));
  assert.match(block, /if \(-not \$Remove\)/);
  assert.match(block, /if \(\$DryRun\) \{[^}]*\} else \{/);
  assert.match(block, /-Force -ErrorAction Stop/);
  assert.ok(block.indexOf("throw 'OrgiastNightlyHealth read-back failed") < block.indexOf('Set-ScheduledTask'));
  assert.match(block, /healthKept.Count -eq 0/);
  assert.match(block, /healthKept.Count -ne @\(\$morning.Actions\).Count/);
  assert.match(block, /legacy health action remains/);
  assert.doesNotMatch(block, /(?:Unregister|Disable|Stop)-ScheduledTask/);
});


test('targeted health repair skips unrelated nightly and deadline registrations', () => {
  assert.match(source, /\[switch\]\$HealthOnly/);
  assert.match(source, /if \(\$HealthOnly\) \{ \$specs = @\(\$specs \| Where-Object \{ \$_.TaskName -eq 'OrgiastMorningBatch'/);
  assert.match(source, /if \(-not \$HealthOnly\) \{\s+& \(Join-Path \$PSScriptRoot 'register-deadline-watch-tasks.ps1'/);
  assert.match(source, /if \(-not \$HealthOnly -and \$kept.Count/);
  assert.match(source, /HealthOnly cannot be combined with Remove/);
});
