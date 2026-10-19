import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./register-nightly-remediate-task.ps1', import.meta.url), 'utf8');

test('remediation runs as its own daily task with a 90 minute limit', () => {
  assert.match(source, /OrgiastNightlyRemediate/);
  assert.match(source, /-Daily -At 7:20am/);
  assert.match(source, /-Minutes 90/);
  assert.match(source, /-Force/);
});

test('registration script stays ASCII-only for Windows PowerShell 5.1', () => {
  for (const ch of source) assert.ok(ch.codePointAt(0) < 128, `non-ASCII character: ${ch}`);
});
