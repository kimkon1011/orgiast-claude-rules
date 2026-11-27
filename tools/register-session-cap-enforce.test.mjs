import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main } from './register-session-cap-enforce.mjs';

test('registration wrapper, readback, hourly schedule and fleet manifest contract', async () => {
  const calls = [], spawnImpl = (...args) => { calls.push(args); return { status: 0, stdout: '' }; };
  assert.equal(await main({ platform: 'win32', spawnImpl, getTaskInfo: async name => {
    assert.equal(name, 'OrgiastSessionCapEnforce'); return { name };
  } }), 0);
  assert.match(calls[0][1].at(-1), /register-session-cap-enforce\.ps1$/);
  await assert.rejects(main({ platform: 'win32', spawnImpl, getTaskInfo: async () => null }), /read-back/);
  await assert.rejects(main({ platform: 'win32', spawnImpl: () => ({ status: 1, stderr: 'failed' }) }), /failed/);
  const source = fs.readFileSync(new URL('./register-session-cap-enforce.ps1', import.meta.url), 'utf8');
  for (const pattern of [/New-ScheduledTaskTrigger -Once -At \(Get-Date\)\.Date.AddMinutes\(15\)/,
    /-RepetitionInterval \(New-TimeSpan -Hours 1\)/, /ensure-run-hidden\.ps1/, /resolve-synced-repo\.ps1/,
    /New-HiddenScheduledTaskAction/, /-ChildArgument @\(\$script\)/, /-Minutes 10/,
    /-MultipleInstances IgnoreNew/, /Get-ScheduledTask/, /Repetition.Interval -ne 'PT1H'/,
    /param\(\[switch\]\$ValidateOnly\)/]) assert.match(source, pattern);
  assert.ok(source.indexOf('if ($ValidateOnly)') < source.indexOf('$action ='));
  const items = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url))).items;
  const index = items.findIndex(x => x.id === 'task:session-cap30'), item = items[index + 1];
  assert.equal(items[index - 1].id, 'task:morning-session-sweep');
  assert.deepEqual(item, { id: 'task:session-cap-enforce', type: 'scheduled-task', severity: 'required',
    spec: { name: 'OrgiastSessionCapEnforce' }, repair: ['register-session-cap-enforce.mjs'],
    description: '全PC: 毎時、閉じてよい・空・ログイン切れ等の不要セッションを projects-archive へ移動（削除なし・稼働中は保護）' });
  const scope = JSON.parse(fs.readFileSync(new URL('./fleet-scope.json', import.meta.url))).entries;
  const entry = scope.find(x => x.path === 'tools/register-session-cap-enforce.ps1');
  assert.equal(entry.scope, 'fleet'); assert.equal(entry.step, item.id);
});
test('non-Windows registration wrapper skips spawning and readback', async () => {
  const forbidden = () => assert.fail('must not register tasks');
  assert.equal(await main({ platform: 'linux', spawnImpl: forbidden, getTaskInfo: forbidden }), 0);
});
