import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GOAL, MAX_TICKS, TERMINAL_OUTCOMES, RETRY_AFTER_CAP_MS,
  canRunWindow,
} from '../../tools/quota-sweep.mjs';
import { decideSweep, resetKey, sameReset } from '../../tools/lib/quota-windows.mjs';

const now = Date.UTC(2026, 9, 21);
const minute = 60_000;
const decision = { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 60 * minute, deadline: now + 57 * minute };
const windows = [
  { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: decision.resetsAt },
  { provider: 'claude', window: '7d', usedPercent: 20, resetsAt: now + 500 * minute },
];

// ── Module export completeness ─────────────────────────────────────────

test('all key functions and constants are exported from the module', () => {
  assert.equal(typeof DEFAULT_GOAL, 'string');
  assert.ok(DEFAULT_GOAL.length > 50);
  assert.equal(MAX_TICKS, 8);
  assert.ok(TERMINAL_OUTCOMES instanceof Set);
  assert.equal(TERMINAL_OUTCOMES.size, 5);
  assert.equal(RETRY_AFTER_CAP_MS, 10 * 60_000);
});

// ── TERMINAL_OUTCOMES and canRunWindow integration ─────────────────────

test('TERMINAL_OUTCOMES contains all terminal states', () => {
  for (const outcome of ['exhausted', 'final', 'ceiling', 'deadline', 'no-goal']) {
    assert.ok(TERMINAL_OUTCOMES.has(outcome), `${outcome} should be terminal`);
  }
  assert.equal(TERMINAL_OUTCOMES.has('failed'), false);
  assert.equal(TERMINAL_OUTCOMES.has('running'), false);
  assert.equal(TERMINAL_OUTCOMES.has('partial'), false);
  assert.equal(TERMINAL_OUTCOMES.has('deferred'), false);
});

test('canRunWindow with TERMINAL_OUTCOMES: each terminal outcome blocks rerun', () => {
  for (const outcome of TERMINAL_OUTCOMES) {
    const state = { lastRun: { claude: { [decision.resetsAt]: { outcome } } } };
    assert.equal(canRunWindow(state, decision), false,
      `canRunWindow should be false for terminal outcome: ${outcome}`);
  }
});

test('canRunWindow allows one retry for failed outcome', () => {
  const state = { lastRun: { claude: { [decision.resetsAt]: { outcome: 'failed', attempts: 1 } } } };
  assert.equal(canRunWindow(state, decision), true);
});

test('canRunWindow blocks second retry for failed', () => {
  const state = { lastRun: { claude: { [decision.resetsAt]: { outcome: 'failed', attempts: 2 } } } };
  assert.equal(canRunWindow(state, decision), false);
});

// ── TERMINAL_OUTCOMES — never contains non-terminal outcomes ───────────

test('TERMINAL_OUTCOMES excludes non-terminal outcomes used by the module', () => {
  const nonTerminal = ['failed', 'running', 'partial', 'deferred', null, undefined, ''];
  for (const name of nonTerminal) {
    const strName = String(name);
    if (name !== null && name !== undefined) {
      assert.equal(TERMINAL_OUTCOMES.has(name), false, `${strName} should not be terminal`);
    }
  }
});

// ── decideSweep + sameReset integration ────────────────────────────────

test('sameReset tolerates minute-boundary jitter', () => {
  const base = Date.UTC(2026, 9, 21, 2, 0, 0);
  assert.ok(sameReset(base - 1500, base));
  assert.ok(sameReset(base + 971, base));
  assert.equal(sameReset(base + 5 * minute, base), false);
});

test('resetKey rounds to nearest minute', () => {
  const base = Date.UTC(2026, 9, 21, 2, 0, 0);
  assert.equal(resetKey(base - 400), base);
  assert.equal(resetKey(base + 192), base);
});

test('decideSweep returns no decisions for empty windows', () => {
  const decisions = decideSweep({ windows: [], now });
  assert.equal(decisions.length, 0);
});

test('decideSweep skips fully utilized windows', () => {
  const decisions = decideSweep({ windows: [{ provider: 'claude', window: '5h', usedPercent: 99, resetsAt: now + 30 * minute }], now });
  assert.equal(decisions.length, 0);
});

test('decideSweep picks the earliest resetting window within lead time', () => {
  const testWindows = [
    { provider: 'claude', window: '5h', usedPercent: 40, resetsAt: now + 30 * minute },
    { provider: 'claude', window: '7d', usedPercent: 20, resetsAt: now + 500 * minute },
  ];
  const decisions = decideSweep({ windows: testWindows, now, leadMinutes: 60 });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].window, '5h');
});