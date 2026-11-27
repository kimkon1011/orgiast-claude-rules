import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main } from './register-session-cap30.mjs';
test('registration wrapper, readback, schedule and manifest contract', async () => {
  const calls = [], spawnImpl = (...args) => { calls.push(args); return { status: 0, stdout: '' }; };
  assert.equal(await main({ platform: 'win32', spawnImpl, getTaskInfo: async name => { assert.equal(name, 'OrgiastSessionCap30'); return { name }; } }), 0);
  assert.match(calls[0][1].at(-1), /register-session-cap30\.ps1$/);
  await assert.rejects(main({ platform: 'win32', spawnImpl, getTaskInfo: async () => null }), /read-back/);
  await assert.rejects(main({ platform: 'win32', spawnImpl: () => ({ status: 1, stderr: 'failed' }) }), /failed/);
  const source = fs.readFileSync(new URL('./register-session-cap30.ps1', import.meta.url), 'utf8');
  for (const pattern of [/New-ScheduledTaskTrigger -Daily -At '04:40'/, /New-HiddenScheduledTaskAction/, /@\(\$script, '--cap', '30'\)/, /-Minutes 10/, /-MultipleInstances IgnoreNew/, /Get-ScheduledTask/, /param\(\[switch\]\$ValidateOnly\)/]) assert.match(source, pattern);
  assert.ok(source.indexOf('if ($ValidateOnly)') < source.indexOf('Register-ScheduledTask -TaskName'));
  const items = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url))).items;
  const index = items.findIndex(x => x.id === 'task:morning-session-sweep');
  assert.equal(items[index + 1].id, 'task:session-cap30');
  assert.deepEqual(items[index + 1].repair, ['register-session-cap30.mjs']);
  assert.equal(items[index + 1].severity, 'required');
});
