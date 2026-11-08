import test from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryLoopState, runWithRecovery, runWithRecoverySync, createCostAwareRecovery, formatRecoveryOutcome } from './bounded-recovery-loop.mjs';
import { CostBudget } from './cost-limiter.mjs';

test('RecoveryLoopState tracks retries', () => {
  const s = new RecoveryLoopState({ maxRetries: 3 });
  assert.equal(s.maxRetries, 3);
  assert.equal(s.remainingRetries, 3);
  assert.ok(s.canRetry);
  s.attempts = 3;
  assert.ok(s.isExhausted);
  assert.ok(!s.canRetry);
});

test('RecoveryLoopState detects timeout', () => {
  const s = new RecoveryLoopState({ timeoutMs: 100 });
  assert.ok(!s.isTimedOut); // just created, elapsed ~0
});

test('RecoveryLoopState detects cost exceeded', () => {
  const s = new RecoveryLoopState({ costLimit: 50 });
  assert.ok(!s.isOverCost);
  s.costSpent = 60;
  assert.ok(s.isOverCost);
});

test('runWithRecovery succeeds on first try', async () => {
  const result = await runWithRecovery(async () => ({ success: true, result: 'done' }), { maxRetries: 3 });
  assert.ok(result.success);
  assert.equal(result.result, 'done');
  assert.equal(result.state.attempts, 1);
});

test('runWithRecovery retries on failure then exhausts', async () => {
  let attempts = 0;
  const result = await runWithRecovery(async () => {
    attempts++;
    return { success: false, error: 'failed' };
  }, { maxRetries: 2, retryDelayMs: 1 });
  assert.ok(!result.success);
  assert.equal(result.state.status, 'exhausted');
  assert.equal(attempts, 2); // initial + 1 retry
});

test('runWithRecovery succeeds after retries', async () => {
  let attempts = 0;
  const result = await runWithRecovery(async () => {
    attempts++;
    if (attempts < 2) return { success: false, error: 'transient' };
    return { success: true, result: 'recovered' };
  }, { maxRetries: 3, retryDelayMs: 1 });
  assert.ok(result.success);
  assert.equal(result.result, 'recovered');
  assert.equal(attempts, 2);
});

test('runWithRecovery catches exceptions', async () => {
  let attempts = 0;
  const result = await runWithRecovery(async () => {
    attempts++;
    throw new Error('crash');
  }, { maxRetries: 1, retryDelayMs: 1 });
  assert.ok(!result.success);
  assert.equal(result.state.errors.length, 1);
});

test('runWithRecoverySync succeeds', () => {
  const result = runWithRecoverySync(() => ({ success: true, result: 'sync done' }), { maxRetries: 1 });
  assert.ok(result.success);
});

test('runWithRecoverySync exhausts', () => {
  const result = runWithRecoverySync(() => ({ success: false, error: 'fail' }), { maxRetries: 1, retryDelayMs: 0 });
  assert.ok(!result.success);
  assert.equal(result.state.status, 'exhausted');
});

test('formatRecoveryOutcome formats success', () => {
  const result = { success: true, state: { attempts: 2, elapsed: 3000 } };
  const formatted = formatRecoveryOutcome(result);
  assert.ok(formatted.includes('Succeeded'));
});

test('formatRecoveryOutcome formats failure', () => {
  const result = { success: false, state: { attempts: 3, elapsed: 5000, status: 'exhausted', errors: [{ attempt: 1, error: 'timeout' }] } };
  const formatted = formatRecoveryOutcome(result);
  assert.ok(formatted.includes('Failed'));
  assert.ok(formatted.includes('exhausted'));
});

test('cost-aware recovery', async () => {
  const budget = new CostBudget({ contractId: 'ca-test', limit: 10 });
  const recovery = createCostAwareRecovery(budget);
  // Verify it returns a function
  assert.equal(typeof recovery, 'function');
});