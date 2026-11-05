import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, main, TARGET_STEPS } from './auto-progress-checks/nishida-converge-dm-reply.mjs';
const beacon = (overrides = {}) => ({ account: 'genbateam.toho@gmail.com', label: 'DESKTOP-BDOAK99', reportedAt: '2026-11-05T02:01:01.144Z',
  steps: TARGET_STEPS.map(id => ({ id, status: 'ok' })), failing: [], ...overrides });
test('truncated steps still report failing as failure, with other steps unknown', () => {
  const out = evaluate([beacon({ steps: [], failing: ['env:cerebras', 'task-hidden-actions'] })]);
  assert.equal(out.code, 1);
  assert.deepEqual(out.steps, { 'task-hidden-actions': 'fail', 'mobile-standby': 'unknown', 'node-runtime-security': 'unknown' });
});
test('success needs recent successful task and standby steps; failure overrides steps', () => {
  assert.equal(evaluate([beacon()]).code, 0);
  for (const b of [beacon({ reportedAt: '2026-10-25T00:00:00Z' }), beacon({ steps: [] }),
    beacon({ failing: 'task-hidden-actions' }), beacon({ failing: ['mobile-standby'] }),
    beacon({ steps: [{ id: 'task-hidden-actions', status: 'skip' }] }), beacon({ label: 'other' })]) assert.equal(evaluate([b]).code, 1);
});
test('latest target beacon wins and absent target remains pending', () => {
  assert.equal(evaluate([beacon(), beacon({ reportedAt: '2026-11-06T00:00:00Z', failing: ['task-hidden-actions'] })]).code, 1);
  assert.equal(evaluate([]).code, 1);
});
test('busy retries are bounded and emit only counts', async () => {
  let calls = 0, waits = 0; const logs = [];
  assert.equal(await main({ fetchBeacons: async () => { calls++; return { ok: false }; }, sleep: async () => { waits++; }, log: x => logs.push(x) }), 2);
  assert.equal(calls, 4); assert.equal(waits, 3); assert.deepEqual(logs, ['{"errors":1}']);
  assert.equal(await main({ fetchBeacons: async () => ({ ok: true, beacons: [beacon({ steps: [], failing: ['task-hidden-actions'] })] }), log: x => logs.push(x) }), 1);
  assert.equal(logs[1], '{"ok":0,"fail":1,"unknown":2}');
});
