import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main as registerMorning } from './register-morning-batch-task.mjs';
import { main as registerNightly } from './register-nightly-tools.mjs';

test('register-morning-batch-task.mjs runs morning then nightly tools ps1', async () => {
  const calls = [];
  await registerMorning({
    platform: 'win32',
    spawnImpl(command, args) {
      calls.push({ command, file: args.at(-1) });
      return { status: 0, stdout: 'ok', stderr: '' };
    },
    getTaskInfo: async () => ({ taskName: 'OrgiastMorningBatch', state: 'Ready' }),
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].file, /register-morning-batch-task\.ps1$/);
  assert.match(calls[1].file, /register-nightly-tools\.ps1$/);
});

test('register-nightly-tools.mjs read-back fails when MorningBatch missing', async () => {
  await assert.rejects(
    () => registerNightly({
      platform: 'win32',
      spawnImpl() { return { status: 0, stdout: 'ok', stderr: '' }; },
      getTaskInfo: async () => null,
    }),
    /read-back failed: OrgiastMorningBatch/,
  );
});

test('setup-manifest wires morning-batch and nightly-health repairs', () => {
  const items = JSON.parse(fs.readFileSync(new URL('./setup-manifest.json', import.meta.url), 'utf8')).items;
  const morning = items.find((item) => item.id === 'task:morning-batch');
  const health = items.find((item) => item.id === 'task:nightly-health');
  assert.equal(morning?.spec?.name, 'OrgiastMorningBatch');
  assert.deepEqual(morning?.repair, ['register-morning-batch-task.mjs']);
  assert.match(morning?.spec?.requiredActionPattern || '', /next-actions/);
  assert.equal(health?.spec?.name, 'OrgiastNightlyHealth');
  assert.deepEqual(health?.repair, ['register-nightly-tools.mjs']);
});
