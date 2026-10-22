import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerStopViolation, summarizeStopRechecks } from './stop-recheck.mjs';

test('同一応答は複数hookでも1 block、書き直し2回後はpass_after_cap', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-recheck-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = { session_id: 's', stop_hook_active: true };
  assert.equal(registerStopViolation({ input, assistantText: 'one', blockedBy: ['a'], reasonCodes: ['A'], home }).blockNumber, 1);
  assert.equal(registerStopViolation({ input, assistantText: 'one', blockedBy: ['b'], reasonCodes: ['B'], home }).blockNumber, 1);
  assert.equal(registerStopViolation({ input, assistantText: 'two', blockedBy: ['a'], reasonCodes: ['A'], home }).verdict, 'block');
  const capped = registerStopViolation({ input, assistantText: 'three', blockedBy: ['a'], reasonCodes: ['A'], home });
  assert.equal(capped.verdict, 'pass_after_cap');
  assert.match(capped.additionalContext, /次の応答で必ず訂正/);
});

test('日次集計は旧skippedとpass_after_capを数える', () => {
  const rows = [
    { ts: '2026-10-18T00:00:00Z', verdict: 'skipped', reasonCodes: ['stop_hook_active'] },
    { ts: '2026-10-18T00:00:01Z', verdict: 'pass_after_cap' },
  ];
  assert.deepEqual(summarizeStopRechecks(rows, { since: Date.parse('2026-10-18') }), { skippedStopHookActive: 1, passAfterCap: 1 });
});
