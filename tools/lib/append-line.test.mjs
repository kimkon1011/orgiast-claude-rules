import assert from 'node:assert/strict';
import test from 'node:test';
import { appendLineWithRetry } from './append-line.mjs';

test('appendLineWithRetry retries Windows sharing failures', async () => {
  let calls = 0;
  const waits = [];
  const fsImpl = { mkdirSync() {}, appendFileSync() { calls += 1; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  await appendLineWithRetry('/tmp/x.log', 'ok', { fsImpl, baseMs: 10, sleepImpl: async (ms) => waits.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);
});

test('appendLineWithRetry does not retry unrelated errors', async () => {
  const fsImpl = { mkdirSync() {}, appendFileSync() { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); } };
  await assert.rejects(appendLineWithRetry('/tmp/x.log', 'x', { fsImpl }), /disk/);
});
