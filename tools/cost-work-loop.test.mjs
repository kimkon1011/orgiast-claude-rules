import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-work-loop-'));
process.env.ORGIAST_HOME = isolatedHome;
fs.mkdirSync(path.join(isolatedHome, '.claude'), { recursive: true });
fs.writeFileSync(path.join(isolatedHome, '.claude', 'delegation-health.md'), '## 🩺 委譲ヘルス（直近24h）\n- high / テスト所見\n');
const { decideEnforcement, summarizeGeminiMonth } = await import('./cost-work-loop.mjs');

const base = { claudeOut: 1_000_000, history: [], target: 0.5, previousMode: 'warn' };

test.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

test('委譲ヘルスをプロバイダ健全性の直前へ挿入する', () => {
  const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'cost-work-loop.mjs')], { env: { ...process.env, ORGIAST_HOME: isolatedHome }, encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  const directive = fs.readFileSync(path.join(isolatedHome, '.claude', 'cost-directive.md'), 'utf8');
  assert.ok(directive.indexOf('## 🩺 委譲ヘルス') < directive.indexOf('### プロバイダ健全性'));
});

test('non-pilot blocks when enforcement conditions are met', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0, daysObserved: 10, pilot: false });
  assert.equal(result.mode, 'block');
  assert.match(result.reason, /cost-enforce-override を作成/);
});

test('override keeps enforcement at warn and explains how to resume it', () => {
  const result = decideEnforcement({ ...base, delegRatio: 0, daysObserved: 10, pilot: false, previousMode: 'block', override: true });
  assert.equal(result.mode, 'warn');
  assert.match(result.reason, /降格/);
  assert.match(result.reason, /cost-enforce-override/);
  assert.match(result.reason, /削除すれば自動判定を再開/);
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

test('lines delegation above target stays warn despite low token delegation', () => {
  const result = decideEnforcement({ ...base, linesRatio: 0.635, delegRatio: 0.19, delegRatioWithPrep: 0.22, daysObserved: 10, pilot: true });
  assert.equal(result.mode, 'warn');
  assert.equal(result.decidedBy, 'linesRatio');
});

test('lines delegation blocks below half target after 3 days', () => {
  const result = decideEnforcement({ ...base, linesRatio: 0.10, daysObserved: 3, pilot: true });
  assert.equal(result.mode, 'block');
});

test('invalid lines delegation falls back to token delegation', () => {
  const result = decideEnforcement({ ...base, linesRatio: null, delegRatioWithPrep: 0.1, daysObserved: 3, pilot: true });
  assert.equal(result.mode, 'block');
  assert.equal(result.decidedBy, 'delegRatioWithPrep');
});

test('7-day enforcement trend reads lines delegation history', () => {
  const flat = decideEnforcement({ ...base, linesRatio: 0.3, history: [{ linesRatio: 0.28 }, { linesRatio: 0.29 }], daysObserved: 7, pilot: true });
  const improving = decideEnforcement({ ...base, linesRatio: 0.3, history: [{ linesRatio: 0.10 }, { linesRatio: 0.29 }], daysObserved: 7, pilot: true });
  assert.equal(flat.mode, 'block');
  assert.equal(improving.mode, 'warn');
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
