import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFirstDayOfMonthJst, jstMonthKey, previousMonthBudget, buildMonthlyReport } from './cost-monthly-report.mjs';

test('JSTで1日だけ月初と判定する', () => {
  // 2026-08-31T16:00Z = 2026-09-01 01:00 JST
  assert.equal(isFirstDayOfMonthJst(new Date('2026-08-31T16:00:00Z')), true);
  assert.equal(isFirstDayOfMonthJst(new Date('2026-09-01T15:00:00Z')), false); // JST では 9/2 00:00
  assert.equal(isFirstDayOfMonthJst(new Date('2026-09-05T00:00:00Z')), false);
});

test('jstMonthKey は JST 月を返す', () => {
  assert.equal(jstMonthKey(new Date('2026-08-31T16:00:00Z')), '2026-09');
});

test('previous month includes JST boundary, ledger USD and unmeasured disclosure', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-gemini-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  const rows = [
    { provider: 'gemini', t: '2026-07-31T15:00:00Z', usd: 2 },
    { provider: 'gemini', t: '2026-08-31T14:59:59Z', usd: null },
    { provider: 'gemini', t: '2026-08-31T15:00:00Z', usd: 99 },
  ];
  fs.writeFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), rows.map(JSON.stringify).join('\n'));
  const now = new Date('2026-09-01T00:00:00Z');
  const budget = previousMonthBudget({ home, now });
  assert.equal(budget.month, '2026-08'); assert.equal(budget.geminiUnmeasuredCalls, 1);
  assert.equal(budget.variableJpy, 300);
  assert.match(buildMonthlyReport({ home, now }), /うち未計測 1 件（実費はこれより大きい）/);
});

test('前月予算は ledger が空でも固定費だけで返す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-budget-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'executor-usage.jsonl'), '');
  const budget = previousMonthBudget({ home, now: new Date('2026-09-01T00:00:00Z') });
  assert.ok(budget.month < '2026-09', budget.month);
  assert.ok(Number.isFinite(budget.fixedJpy));
  assert.ok(Number.isFinite(budget.totalJpy));
});

test('月次レポート本文を組み立てられる', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-report-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const text = buildMonthlyReport({ home, now: new Date('2026-09-01T00:00:00Z') });
  assert.match(text, /コスト月次レポート/);
  assert.match(text, /確定コスト/);
  assert.match(text, /適用した提案と効果/);
});
