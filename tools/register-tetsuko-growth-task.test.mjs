import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./register-tetsuko-growth-task.ps1', import.meta.url), 'utf8');

// Windows PowerShell 5.1 decodes a BOM-less .ps1 as Shift-JIS, so a non-ASCII byte in a
// file without a BOM silently breaks parsing. The invariant is "ASCII-only OR BOM present",
// not "ASCII-only", so a future edit may add Japanese as long as it keeps the BOM.
test('parses under PowerShell 5.1: ASCII-only, or a BOM when it is not', () => {
  const hasBom = source.charCodeAt(0) === 0xfeff;
  const asciiOnly = /^[\x00-\x7F]*$/.test(source);
  assert.ok(
    hasBom || asciiOnly,
    'non-ASCII byte in a BOM-less .ps1: PowerShell 5.1 would decode it as Shift-JIS and break'
  );
});

test('registers the TETSUKO growth loop daily at 06:30 through nightly-bootstrap', () => {
  assert.match(source, /OrgiastTetsukoGrowth/);
  assert.match(source, /New-ScheduledTaskTrigger -Daily -At '06:30'/);
  assert.match(source, /tetsuko-growth-loop\.mjs/);
  assert.match(source, /nightly-bootstrap\.ps1/);
  assert.match(source, /Register-ScheduledTask -TaskName \$taskName/);
});

// The 2026-09-16 incident: a task registered from whatever tree the script sat in kept
// running stale code. Registration must resolve the synced repo instead.
test('runs from the synced repo, not from the tree the script sits in', () => {
  assert.match(source, /Resolve-RegisterRepoRoot/);
  assert.match(source, /RequiredPaths @\('tools\\tetsuko-growth-loop\.mjs', 'tools\\nightly-bootstrap\.ps1'\)/);
});

test('dry-run exits before anything is registered', () => {
  const dryRun = source.indexOf('if ($DryRun)');
  const register = source.indexOf('Register-ScheduledTask');
  assert.ok(dryRun >= 0, '$DryRun switch handling is missing');
  assert.ok(register > dryRun, 'DryRun must be handled before Register-ScheduledTask');
  assert.match(source, /if \(\$DryRun\)[\s\S]*?exit 0/);
});

test('-Unregister removes the task instead of creating it', () => {
  assert.match(source, /\[switch\]\$Unregister/);
  assert.match(source, /Unregister-ScheduledTask -TaskName \$taskName -Confirm:\$false/);
});

test('the registered task is read back and no machine-specific path is hardcoded', () => {
  assert.match(source, /Read back|Get-ScheduledTask -TaskName \$taskName \| Select-Object TaskName, State/);
  assert.doesNotMatch(source, /C:\\Users\\/i);
});
