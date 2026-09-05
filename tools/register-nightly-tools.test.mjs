import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./register-nightly-tools.ps1', import.meta.url), 'utf8');

test('existing scheduled tasks are extended without creating tasks', () => {
  const forbiddenCommand = ['Register', 'ScheduledTask'].join('-');
  assert.doesNotMatch(source, new RegExp(`\\b${forbiddenCommand}\\b`, 'i'));
  assert.match(source, /Set-ScheduledTask[\s\S]*-Action\s*\(@\(\$task\.Actions\)\s*\+\s*\$newAction\)/i);
});

test('dry-run and removal switches are part of the contract', () => {
  assert.match(source, /\[switch\]\$DryRun\b/);
  assert.match(source, /\[switch\]\$Remove\b/);
});

test('all three nightly scripts are wired', () => {
  for (const script of ['next-actions.mjs', 'nightly-health.mjs', 'pricing-brief.mjs']) {
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
