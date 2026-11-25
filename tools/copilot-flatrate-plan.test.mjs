import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { computeCosts, formatReport, runPlan } from './copilot-flatrate-plan.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'copilot-flatrate-catalog.json'), 'utf8'));
const costs = (overrides = {}) => computeCosts({ seats: 30, planId: 'business', creditsPerSeat: 1900, paidOverageAllowed: true, usdJpy: 150, copilotBudgetUsd: 1000, catalog, ...overrides });

test('business 30 seats は許容量ちょうどなら超過0', () => {
  const result = costs();
  assert.equal(result.pooledCredits, 57000);
  assert.equal(result.usedCredits, 57000);
  assert.equal(result.overageCredits, 0);
  assert.equal(result.overageUsd, 0);
});

test('business 2500 credits/seat、従量ONは $750', () => {
  const result = costs({ creditsPerSeat: 2500 });
  assert.equal(result.overageCredits, 18000);
  assert.equal(result.overageUsd, 180);
  assert.equal(result.totalUsd, 750);
});

test('同じ超過でも従量OFFは超過creditsを残し $570 が上限', () => {
  const result = costs({ creditsPerSeat: 2500, paidOverageAllowed: false });
  assert.equal(result.overageCredits, 18000);
  assert.equal(result.overageUsd, 0);
  assert.equal(result.totalUsd, 570);
  assert.equal(result.ceilingUsd, 570);
});

test('未計測は null を0に潰さず削減額を断定しない', () => {
  const result = costs({ creditsPerSeat: null });
  assert.equal(result.totalUsd, 570);
  assert.equal(result.ceilingUsd, null);
  assert.equal(result.overageCredits, null);
  assert.equal(result.budgetExceededUsd, null);
  assert.equal(result.unmeasured, true);
});

test('enterprise 10 seats 5000 credits/seat は超過 $110', () => {
  const result = costs({ seats: 10, planId: 'enterprise', creditsPerSeat: 5000 });
  assert.equal(result.pooledCredits, 39000);
  assert.equal(result.usedCredits, 50000);
  assert.equal(result.overageCredits, 11000);
  assert.equal(result.overageUsd, 110);
});

test('$750 を150円換算すると112500円', () => {
  assert.equal(costs({ creditsPerSeat: 2500 }).totalJpy, 112500);
});

test('予算 $1000 に対して $750 は超過しない', () => {
  const result = costs({ creditsPerSeat: 2500 });
  assert.equal(result.budgetExceeded, false);
  assert.equal(result.budgetExceededUsd, 0);
});

test('business 5000 credits/seat は $1500 で予算を $500 超過', () => {
  const result = costs({ creditsPerSeat: 5000 });
  assert.equal(result.overageCredits, 93000);
  assert.equal(result.totalUsd, 1500);
  assert.equal(result.budgetExceededUsd, 500);
});

test('business の損益分岐指標は3800 credits/seat', () => {
  assert.equal(costs().breakEvenCreditsPerSeat, 3800);
});

test('free の含有credits非公表を例外にせず返す', () => {
  const result = costs({ seats: 1, planId: 'free', creditsPerSeat: null });
  assert.equal(result.pooledCredits, null);
  assert.equal(result.planCreditsUnverified, true);
  assert.equal(result.unmeasured, true);
});

test('未計測レポートは未計測と実費の注意を含む', () => {
  const result = costs({ creditsPerSeat: null });
  const report = formatReport(result, { catalog, seats: 30, planId: 'business', creditsPerSeat: null, paidOverageAllowed: true, usdJpy: 150 });
  assert.match(report, /未計測/);
  assert.match(report, /実費はこれより大きい可能性/);
  assert.match(report, /削減額・損益分岐の達成を断定しない/);
});

test('生成docにdriftがない', () => {
  let stderr = '';
  const code = runPlan({ repo, seats: 30, planId: 'business', creditsPerSeat: null, paidOverageAllowed: false, usdJpy: 150, copilotBudgetUsd: 1000, check: true, stderr: { write: (value) => { stderr += value; } } });
  assert.equal(code, 0, stderr);
});
