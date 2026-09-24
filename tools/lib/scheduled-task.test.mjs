import assert from 'node:assert/strict';
import test from 'node:test';
import { getScheduledTaskInfo, registerHourlyTask } from './scheduled-task.mjs';

test('getScheduledTaskInfo maps a missing task to null', async () => {
  let script = '';
  const result = await getScheduledTaskInfo('missing', { spawnImpl: (_exe, args) => { script = args.at(-1); return { status: 0, stdout: 'null\n', stderr: '' }; } });
  assert.equal(result, null);
  assert.match(script, /NoMatchingMSFT_ScheduledTaskFound/);
});

test('getScheduledTaskInfo still throws other PowerShell failures', async () => {
  await assert.rejects(Promise.resolve().then(() => getScheduledTaskInfo('broken', { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'access denied' }) })), /access denied/);
});

test('registerHourlyTask uses run-hidden and an idempotent hourly task definition', () => {
  let invocation;
  const spawnImpl = (exe, args, options) => { invocation = { exe, args, options }; return { status: 0, stdout: '', stderr: '' }; };
  registerHourlyTask('OrgiastProcessHygiene', 'C:\\repo\\tools\\process-hygiene.mjs', { home: 'C:\\Users\\kim', spawnImpl });
  assert.equal(invocation.exe, 'powershell.exe');
  assert.match(invocation.args.at(-1), /Register-ScheduledTask.*OrgiastProcessHygiene/);
  assert.match(invocation.args.at(-1), /run-hidden\.vbs.*process-hygiene\.mjs.*--kill/);
  assert.match(invocation.args.at(-1), /New-TimeSpan -Hours 1/);
  assert.match(invocation.args.at(-1), /-Force/);
});
