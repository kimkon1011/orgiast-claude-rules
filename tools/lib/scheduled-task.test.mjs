import assert from 'node:assert/strict';
import test from 'node:test';
import { getScheduledTaskInfo } from './scheduled-task.mjs';

test('getScheduledTaskInfo maps a missing task to null', async () => {
  let script = '';
  const result = await getScheduledTaskInfo('missing', { spawnImpl: (_exe, args) => { script = args.at(-1); return { status: 0, stdout: 'null\n', stderr: '' }; } });
  assert.equal(result, null);
  assert.match(script, /NoMatchingMSFT_ScheduledTaskFound/);
});

test('getScheduledTaskInfo still throws other PowerShell failures', async () => {
  await assert.rejects(Promise.resolve().then(() => getScheduledTaskInfo('broken', { spawnImpl: () => ({ status: 1, stdout: '', stderr: 'access denied' }) })), /access denied/);
});
