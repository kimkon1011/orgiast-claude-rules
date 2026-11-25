import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ASTRA_EFFICIENCY_FACTOR, SCENARIOS, analyzeScenario, breakEvenAnalysis, calculateCost, calculatePlan, runPlan } from './astra-sol-cost-plan.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'astra-sol-cost-catalog.json'), 'utf8'));
const scenario = (id) => SCENARIOS.find((item) => item.id === id);

test('Astra standard 単価をcatalogからread-throughできる', () => {
  assert.deepEqual(catalog.models['gpt-6-astra'].tiers.standard, { shortInput: 10, shortCached: 1, shortWrites: 12.5, shortOutput: 50, longInput: 20, longCached: 2, longWrites: 25, longOutput: 75 });
});

test('Sol standard 単価をcatalogからread-throughできる', () => {
  assert.deepEqual(catalog.models['gpt-5.6-sol'].tiers.standard, { shortInput: 4, shortCached: 0.4, shortWrites: 5, shortOutput: 20, longInput: 8, longCached: 0.8, longWrites: 10, longOutput: 30 });
});

test('nightly-batch Astra は 300×5 + 30×25 = $2250', () => {
  assert.equal(analyzeScenario(scenario('nightly-batch'), catalog).costs['gpt-6-astra'].costUsd, 2250);
});

test('nightly-batch Sol は 300×2 + 30×10 = $900、比率2.5', () => {
  const result = analyzeScenario(scenario('nightly-batch'), catalog);
  assert.equal(result.costs['gpt-5.6-sol'].costUsd, 900);
  assert.equal(result.ratio, 2.5);
});

test('chat-assistant Sol は 170×0.4 + 30×4 + 20×20 = $588', () => {
  assert.equal(analyzeScenario(scenario('chat-assistant'), catalog).costs['gpt-5.6-sol'].costUsd, 588);
});

test('coding-agent はshort/longのcachedを個別に分離して $1315.20', () => {
  assert.equal(analyzeScenario(scenario('coding-agent'), catalog).costs['gpt-5.6-sol'].costUsd, 1315.2);
});

test('doc-summarize Astra flex は 500×10 + 50×37.5 = $6875', () => {
  assert.equal(analyzeScenario(scenario('doc-summarize'), catalog).costs['gpt-6-astra'].costUsd, 6875);
});

test('realtime-quick Sol は 35×4 + 15×0.4 + 5×20 = $246', () => {
  assert.equal(analyzeScenario(scenario('realtime-quick'), catalog).costs['gpt-5.6-sol'].costUsd, 246);
});

test('価格比2.5のブレークイーブンは消費トークン40%', () => {
  const result = breakEvenAnalysis(2.5, 0.4);
  assert.equal(result.threshold, 0.4);
  assert.equal(result.equalCostAtThreshold, true);
  assert.equal(result.astraWins, false);
});

test('69%減の31%消費ならAstraがブレークイーブンを下回る', () => {
  assert.equal(breakEvenAnalysis(2.5, ASTRA_EFFICIENCY_FACTOR).astraWins, true);
});

test('69%減の参考費用は通常Astra費用の31%', () => {
  const result = analyzeScenario(scenario('nightly-batch'), catalog);
  assert.equal(result.efficiencyReference.astraCostUsd, 697.5);
  assert.equal(result.efficiencyReference.status, 'unverified-secondary');
});

test('price-only winner は全シナリオでSol', () => {
  assert.deepEqual(calculatePlan(catalog).scenarios.map((item) => item.winner), Array(5).fill('gpt-5.6-sol'));
});

test('不正なcached比率を拒否する', () => {
  assert.throws(() => calculateCost({ ...scenario('chat-assistant'), shortCachedRatio: 1.1 }, catalog.models['gpt-5.6-sol'].tiers.standard), /cachedRatio/);
});

test('生成docにdriftがない', () => {
  let stderr = '';
  const code = runPlan({ repo, check: true, stderr: { write: (value) => { stderr += value; } } });
  assert.equal(code, 0, stderr);
});
