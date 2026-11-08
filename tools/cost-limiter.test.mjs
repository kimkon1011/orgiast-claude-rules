import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CostBudget, loadBudget, saveBudget, getOrCreateBudget, spend, wouldExceedBudget, resetBudget, costSummary } from './cost-limiter.mjs';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-test-'));
const ledgerDir = path.join(testDir, 'ledger');

test('CostBudget tracks spending', () => {
  const b = new CostBudget({ contractId: 'test', limit: 100, spent: 0 });
  assert.equal(b.remaining, 100);
  assert.ok(!b.exhausted);
  assert.equal(b.utilization, 0);
  b.spent = 50;
  assert.equal(b.remaining, 50);
  assert.equal(b.utilization, 0.5);
  assert.ok(!b.exhausted);
  b.spent = 100;
  assert.ok(b.exhausted);
});

test('saveBudget and loadBudget round-trip', () => {
  const b = new CostBudget({ contractId: 'save-test', limit: 50, spent: 10 });
  saveBudget(b, { ledgerDir });
  const loaded = loadBudget('save-test', { ledgerDir });
  assert.equal(loaded.contractId, 'save-test');
  assert.equal(loaded.limit, 50);
  assert.equal(loaded.spent, 10);
});

test('getOrCreateBudget creates new or returns existing', () => {
  const b1 = getOrCreateBudget('get-create-test', 200, { ledgerDir });
  assert.equal(b1.limit, 200);
  const b2 = getOrCreateBudget('get-create-test', 999, { ledgerDir });
  assert.equal(b2.limit, 200); // Existing, not overwritten
});

test('spend updates budget and detects exhaustion', () => {
  const b = new CostBudget({ contractId: 'spend-test', limit: 10, spent: 0 });
  assert.ok(spend(b, 5, { ledgerDir }));
  assert.equal(b.spent, 5);
  // Second spend brings to exactly limit → exhausted, spend returns false
  assert.ok(!spend(b, 5, { ledgerDir }));
  assert.ok(b.exhausted);
  // Already exhausted, spend returns false
  assert.ok(!spend(b, 1, { ledgerDir }));
});

test('wouldExceedBudget predicts overage', () => {
  const b = new CostBudget({ contractId: 'predict', limit: 10, spent: 8 });
  assert.ok(wouldExceedBudget(b, 3));
  assert.ok(!wouldExceedBudget(b, 2));
});

test('resetBudget clears spending', () => {
  const b = getOrCreateBudget('reset-test', 100, { ledgerDir });
  b.spent = 75;
  saveBudget(b, { ledgerDir });
  resetBudget('reset-test', { ledgerDir });
  const loaded = loadBudget('reset-test', { ledgerDir });
  assert.equal(loaded.spent, 0);
});

test('costSummary aggregates', () => {
  // Clear ledger
  for (const f of fs.readdirSync(ledgerDir)) fs.rmSync(path.join(ledgerDir, f));
  const b1 = getOrCreateBudget('summary-1', 100, { ledgerDir });
  const b2 = getOrCreateBudget('summary-2', 200, { ledgerDir });
  b1.spent = 30; saveBudget(b1, { ledgerDir });
  b2.spent = 50; saveBudget(b2, { ledgerDir });
  const summary = costSummary({ ledgerDir });
  assert.equal(summary.totalSpent, 80);
  assert.equal(summary.totalLimit, 300);
  assert.equal(summary.contracts.length, 2);
});

// Cleanup
test('cleanup', () => { fs.rmSync(testDir, { recursive: true, force: true }); });