import test from 'node:test';
import assert from 'node:assert/strict';
import { selectGoal, sweepFailureStop, makeLedger } from '../../tools/quota-sweep.mjs';

const now = Date.UTC(2026, 9, 21);
const minute = 60_000;
const decision = { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 60 * minute, deadline: now + 57 * minute };

// ── selectGoal ─────────────────────────────────────────────────────────

test('selectGoal prioritizes goals file over handoff', () => {
  const result = selectGoal({
    goals: '- [ ] fix import\n- [x] done\n',
    handoff: '## 残TODO\n1. cleanup\n',
  });
  assert.equal(result.goal, 'fix import');
  assert.equal(result.goalSource, 'quota-sweep-goals.md');
});

test('selectGoal falls back to handoff when goals have no actionable items', () => {
  const result = selectGoal({
    goals: '- [x] done\n- [x] completed already\n',
    handoff: '## 残TODO\n1. fix memory leak\n',
  });
  assert.equal(result.goal, 'fix memory leak');
  assert.equal(result.goalSource, 'next-session.md');
});

test('selectGoal returns null goal for empty handoff and no goals', () => {
  assert.equal(selectGoal({}).goal, null);
  assert.equal(selectGoal({ goals: '' }).goal, null);
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. なし\n' }).goal, null);
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. 完了\n' }).goal, null);
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. none (done)\n' }).goal, null);
});

test('selectGoal cascades correctly through empty/falsy inputs', () => {
  assert.equal(selectGoal({}).goal, null);
  assert.equal(selectGoal({ goals: '', handoff: '' }).goal, null);
  assert.equal(selectGoal({ goals: '- [x] all done\n- [x] every item\n' }).goal, null);
  assert.equal(selectGoal({ handoff: '## 残TODO\n1. なし（完了）\n' }).goal, null);
});

// ── sweepFailureStop ───────────────────────────────────────────────────

test('sweepFailureStop detects 3 consecutive failures', () => {
  const rows = [
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed', stopOutcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'failed', stopOutcome: 'failed' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'claude', outcome: 'failed', stopOutcome: 'failed' },
  ];
  const result = sweepFailureStop(rows, 'claude');
  assert.ok(result !== null);
  assert.equal(result.failures, 3);
});

test('sweepFailureStop resets count on final outcome', () => {
  const rows = [
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'final' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
  ];
  const result = sweepFailureStop(rows, 'claude');
  assert.equal(result, null);
});

test('sweepFailureStop only counts same provider', () => {
  const rows = [
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'codex', outcome: 'failed' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'codex', outcome: 'failed' },
  ];
  assert.equal(sweepFailureStop(rows, 'claude'), null);
  assert.equal(sweepFailureStop(rows, 'codex'), null);
});

test('sweepFailureStop respects since threshold', () => {
  const rows = [
    { ts: new Date(now - 20 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 10 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
  ];
  assert.equal(sweepFailureStop(rows, 'claude', { since: now - 15 * minute }), null);
  assert.ok(sweepFailureStop(rows, 'claude', { since: now - 25 * minute }) !== null);
});

test('sweepFailureStop respects custom threshold', () => {
  const rows = [
    { ts: new Date(now - 5 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
    { ts: new Date(now - 1 * minute).toISOString(), provider: 'claude', outcome: 'failed' },
  ];
  assert.equal(sweepFailureStop(rows, 'claude', { threshold: 2 }).failures, 2);
  assert.equal(sweepFailureStop(rows, 'claude', { threshold: 3 }), null);
});

// ── makeLedger ─────────────────────────────────────────────────────────

test('makeLedger creates valid ledger entry', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now + 3000,
    goal: 'test-goal', goalSource: 'quota-sweep-goals.md',
    outcome: 'final', ticks: 3,
    branch: 'quota-sweep/test-branch',
  });
  assert.equal(row.provider, 'claude');
  assert.equal(row.window, '5h');
  assert.equal(row.outcome, 'final');
  assert.equal(row.ticks, 3);
  assert.equal(row.durationSec, 3);
  assert.equal(row.goal, 'test-goal');
  assert.equal(row.usedAfter, null);
  assert.ok(row.ts);
  assert.ok(row.resetsAt);
});

test('makeLedger preserves failureKey and deliveryError', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now + 1000,
    goal: 'fix', goalSource: 'builtin',
    outcome: 'failed', failureKey: 'child-1',
    reason: 'child exit 1', deliveryError: 'push timeout',
  });
  assert.equal(row.failureKey, 'child-1');
  assert.equal(row.reason, 'child exit 1');
  assert.equal(row.deliveryError, 'push timeout');
});

test('makeLedger calculates non-negative duration', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now - 1000,
    goal: 'test', goalSource: 'builtin', outcome: 'failed',
  });
  assert.equal(row.durationSec, 0);
});

test('makeLedger records usedAfter when provided', () => {
  const row = makeLedger({
    decision, startedAt: now, endedAt: now + 2000,
    goal: 'test', goalSource: 'builtin', outcome: 'final',
    usedAfter: 55,
  });
  assert.equal(row.usedAfter, 55);
});