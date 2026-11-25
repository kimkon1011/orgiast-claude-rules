import test from 'node:test';
import assert from 'node:assert/strict';
import { runWhenPresent } from './wait-for-script.mjs';

test('一時欠損から復旧後に一度だけ子を起動し終了コードを引き継ぐ', async () => {
  const waits = [];
  const rc = await runWhenPresent('target.mjs', ['--arg'], {
    exists: () => waits.length >= 2, wait: async ms => waits.push(ms),
    spawn: (exe, args) => { assert.equal(exe, process.execPath); assert.deepEqual(args, ['target.mjs', '--arg']); return { status: 7 }; },
  });
  assert.deepEqual(waits, [30000, 30000]);
  assert.equal(rc, 7);
});
test('5回待っても存在しなければ起動しない', async () => {
  const waits = [];
  await assert.rejects(runWhenPresent('missing.mjs', [], {
    exists: () => false, wait: async ms => waits.push(ms), spawn: () => assert.fail('unexpected spawn'),
  }), /5 retries/);
  assert.deepEqual(waits, Array(5).fill(30000));
});
