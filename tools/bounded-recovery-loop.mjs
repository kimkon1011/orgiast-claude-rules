// X-0021: Bounded recovery loop with max retries, timeout, and cost limits.
// Prevents infinite retry loops by enforcing hard limits on recovery attempts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = path.dirname(toolsDir);

// State for a bounded recovery loop
export class RecoveryLoopState {
  constructor({ maxRetries = 3, timeoutMs = 300000, costLimit = 0, retryDelayMs = 5000 } = {}) {
    this.attempts = 0;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.costLimit = costLimit;
    this.costSpent = 0;
    this.retryDelayMs = retryDelayMs;
    this.startedAt = Date.now();
    this.lastAttemptAt = null;
    this.errors = [];
    this.status = 'idle'; // idle | running | succeeded | exhausted | timed_out | cost_exceeded
  }

  get remainingRetries() { return Math.max(0, this.maxRetries - this.attempts); }
  get elapsed() { return Date.now() - this.startedAt; }
  get isTimedOut() { return this.elapsed > this.timeoutMs; }
  get isExhausted() { return this.attempts >= this.maxRetries; }
  get isOverCost() { return this.costLimit > 0 && this.costSpent >= this.costLimit; }
  get canRetry() { return !this.isExhausted && !this.isTimedOut && !this.isOverCost; }
}

// Execute a task with bounded recovery loop.
// The taskFn receives (state) and should return { success, result } or throw.
// Returns final outcome after retries or exhaustion.
export async function runWithRecovery(taskFn, options = {}, { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const state = new RecoveryLoopState(options);
  state.status = 'running';

  while (state.canRetry) {
    state.attempts++;
    state.lastAttemptAt = Date.now();

    try {
      const outcome = await taskFn(state);

      if (outcome?.success) {
        state.status = 'succeeded';
        return { success: true, result: outcome.result, state };
      }

      // Task completed but reported failure
      state.errors.push({ attempt: state.attempts, error: outcome?.error || 'Task returned failure', time: Date.now() });

      if (!state.canRetry) break;

      // Wait before retry
      await sleep(state.retryDelayMs);

    } catch (err) {
      state.errors.push({ attempt: state.attempts, error: String(err.message || err), time: Date.now() });

      if (!state.canRetry) break;

      await sleep(state.retryDelayMs);
    }
  }

  // Determine terminal status
  if (state.isTimedOut) state.status = 'timed_out';
  else if (state.isOverCost) state.status = 'cost_exceeded';
  else if (state.isExhausted) state.status = 'exhausted';

  return { success: false, state };
}

// Synchronous version of recovery loop for non-async tasks.
export function runWithRecoverySync(taskFn, options = {}) {
  const state = new RecoveryLoopState(options);
  state.status = 'running';

  while (state.canRetry) {
    state.attempts++;
    state.lastAttemptAt = Date.now();

    try {
      const outcome = taskFn(state);

      if (outcome?.success) {
        state.status = 'succeeded';
        return { success: true, result: outcome.result, state };
      }

      state.errors.push({ attempt: state.attempts, error: outcome?.error || 'Task returned failure', time: Date.now() });
    } catch (err) {
      state.errors.push({ attempt: state.attempts, error: String(err.message || err), time: Date.now() });
    }
  }

  if (state.isTimedOut) state.status = 'timed_out';
  else if (state.isOverCost) state.status = 'cost_exceeded';
  else if (state.isExhausted) state.status = 'exhausted';

  return { success: false, state };
}

// Create a recovery handler for cost-limited execution.
// Integrates with cost-limiter.mjs.
export function createCostAwareRecovery(costBudget, options = {}) {
  return async (taskFn, { onSpend } = {}) => {
    const costOptions = {
      ...options,
      costLimit: costBudget.limit,
      costSpent: costBudget.spent,
    };

    const result = await runWithRecovery(async (state) => {
      // Check cost before running
      if (costBudget.exhausted) {
        return { success: false, error: 'Budget exhausted' };
      }
      const outcome = await taskFn(state);
      // Deduct cost after attempt
      const cost = onSpend ? onSpend(outcome) : 1;
      costBudget.spent += cost;
      state.costSpent = costBudget.spent;
      return outcome;
    }, costOptions);

    return result;
  };
}

// Format recovery outcome for logging.
export function formatRecoveryOutcome(result) {
  if (result?.success) {
    return `✅ Succeeded after ${result.state.attempts} attempt(s) in ${Math.round(result.state.elapsed / 1000)}s`;
  }
  const s = result?.state;
  if (!s) return '❌ No result';
  return [
    `❌ Failed after ${s.attempts} attempt(s) in ${Math.round(s.elapsed / 1000)}s`,
    `  Status: ${s.status}`,
    `  Errors: ${s.errors.length}`,
    ...s.errors.slice(-3).map(e => `  - Attempt ${e.attempt}: ${String(e.error).slice(0, 200)}`),
  ].join('\n');
}