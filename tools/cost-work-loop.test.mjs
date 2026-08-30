import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-work-loop-'));
process.env.ORGIAST_HOME = isolatedHome;
const { decideEnforcement, summarizeGeminiMonth } = await import('./cost-work-loop.mjs');

const base = { claudeOut: 1_000_000, history: [], target: 0.5, previousMode: 'warn' };

test.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

test('non-pilot remains warn after 10 days at 0% delegation', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0, daysObserved: 10, pilot: false });
  assert.equal(result.mode, 'warn');
  assert.match(result.reason, /cost-enforce-pilot が無い/);
});

test('non-pilot demotes a previous block to warn', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0, daysObserved: 10, pilot: false, previousMode: 'block' });
  assert.equal(result.mode, 'warn');
  assert.match(result.reason, /降格/);
});

test('pilot blocks at 15% delegation after 3 days', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0.15, daysObserved: 3, pilot: true });
  assert.equal(result.mode, 'block');
});

test('pilot remains warn at 60% delegation', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0.6, daysObserved: 10, pilot: true });
  assert.equal(result.mode, 'warn');
});

test('enforcement uses delegation ratio including preparation', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0.1, delegRatioWithPrep: 0.6, daysObserved: 10, pilot: true });
  assert.equal(result.mode, 'warn');
});

test('enforcement trend supports adjusted and legacy history entries', () => {
  const history = [{ delegRatio: 0.1 }, { delegRatio: 0.1, delegRatioWithPrep: 0.3 }, { delegRatio: 0.1, delegRatioWithPrep: 0.4 }];
  const result = decideEnforcement({ ...base, delegRatioWithPrep: 0.4, history, daysObserved: 10, pilot: true });
  assert.equal(result.mode, 'warn');
});

function geminiRows(count, overrides = {}) {
  return Array.from({ length: count }, () => ({ t: '2026-08-15T00:00:00Z', provider: 'gemini', grounded: true, in: 0, out: 0, ...overrides }));
}

test('Gemini 検索 6,000 回は超過 1,000 件で $14', () => {
  const result = summarizeGeminiMonth(geminiRows(6000), { now: new Date('2026-08-30T00:00:00Z') });
  assert.equal(result.billableSearches, 1000);
  assert.equal(result.searchUsd, 14);
});

test('Gemini 検索は無料枠内なら検索課金 $0', () => {
  const result = summarizeGeminiMonth(geminiRows(5000), { now: new Date('2026-08-30T00:00:00Z') });
  assert.equal(result.searchUsd, 0);
});

test('Gemini 検索が無料枠の 80% を超えると警告', () => {
  const result = summarizeGeminiMonth(geminiRows(4001), { now: new Date('2026-08-30T00:00:00Z') });
  assert.ok(result.flags.some((flag) => flag.includes('80%超（4001/5000）')));
});
