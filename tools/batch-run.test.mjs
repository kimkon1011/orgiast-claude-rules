import assert from 'node:assert/strict';
import test from 'node:test';
import { batchDeadline } from './lib/batch-deadline.mjs';

test('batch deadline defaults to local 06:30 and accepts override', () => {
  const now = new Date(2026, 8, 10, 3, 0);
  assert.equal(batchDeadline(now, '06:30').getHours(), 6);
  assert.equal(batchDeadline(now, '05:45').getMinutes(), 45);
  assert.throws(() => batchDeadline(now, '25:00'), /invalid/);
});
