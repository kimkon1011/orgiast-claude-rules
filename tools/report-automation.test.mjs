import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  buildReport, metricsFor, monthOverMonth, normalizeAdRows, normalizeDealRows,
  normalizeStage, parseCsv, renderMarkdown, rowsToObjects, summarize, verdictFor,
} from './report-automation.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'tools', 'report-automation-catalog.json'), 'utf8'));
const adText = fs.readFileSync(path.join(repo, 'tools', 'report-automation', 'fixtures', 'ad-metrics.csv'), 'utf8');
const dealText = fs.readFileSync(path.join(repo, 'tools', 'report-automation', 'fixtures', 'hubspot-deals.csv'), 'utf8');
const built = buildReport(adText, dealText, catalog);
const campaign = (id) => built.campaigns.find((row) => row.campaign === id);

test('parseCsv は引用符つきフィールドと "" エスケープを扱える', () => {
  const parsed = parseCsv('a,b\n"x,1","he said ""hi"""\n');
  assert.deepEqual(parsed.header, ['a', 'b']);
  assert.deepEqual(parsed.rows, [['x,1', 'he said "hi"']]);
});

test('parseCsv は CRLF と末尾の空行を扱える', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n\r\n').rows, [['1', '2']]);
});

test('parseCsv は空文字で header/rows とも空になる', () => {
  assert.deepEqual(parseCsv(''), { header: [], rows: [] });
});

test('rowsToObjects は header をキーに対応づける', () => {
  assert.deepEqual(rowsToObjects(parseCsv('a,b\n1,2\n')), [{ a: '1', b: '2' }]);
});

test('normalizeStage は表記ゆれを won に寄せる', () => {
  for (const raw of ['closedwon', 'Closed Won', 'closed_won', '受注']) {
    assert.equal(normalizeStage(raw, catalog), 'won');
  }
});

test('normalizeStage は未知のステージで null を返す', () => {
  assert.equal(normalizeStage('謎ステージ', catalog), null);
});

test('normalizeDealRows は deal_id の重複を除去する', () => {
  const result = normalizeDealRows(dealText, catalog);
  assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.rows.length, 8);
});

test('buildReport は期間と取り込み行数を返す', () => {
  assert.equal(built.period, '2026-09');
  assert.equal(built.previousPeriod, '2026-08');
  assert.equal(built.adRows, 6);
  assert.equal(built.dealRows, 9);
  assert.equal(built.duplicatesRemoved, 1);
});

test('buildReport はキャンペーンを名前の昇順で並べる', () => {
  assert.deepEqual(built.campaigns.map((row) => row.campaign), ['always-on', 'spring-booth', 'summer-seminar']);
});

test('always-on 2026-09 は CPA 1万円・ROAS 0・leads 2 件', () => {
  assert.equal(campaign('always-on').cpa, 110000 / 11);
  assert.equal(campaign('always-on').roas, 0);
  assert.equal(campaign('always-on').leads, 2);
  assert.equal(campaign('always-on').wonDeals, 0);
});

test('spring-booth 2026-09 は受注3件 450万円・ROAS 10', () => {
  assert.equal(campaign('spring-booth').wonAmountJpy, 4500000);
  assert.equal(campaign('spring-booth').wonDeals, 3);
  assert.equal(campaign('spring-booth').roas, 4500000 / 450000);
});

test('合計は率を平均せず合計から再計算する', () => {
  assert.equal(built.totals.wonAmountJpy, 5100000);
  assert.equal(built.totals.roas, 5100000 / 740000);
  assert.equal(built.totals.leads, 6);
});

test('分母が0の率は null（0やInfinityにしない）', () => {
  const metrics = metricsFor({ impressions: 0, clicks: 0, costJpy: 1000, conversions: 0 }, []);
  assert.equal(metrics.ctr, null);
  assert.equal(metrics.cpc, null);
  assert.equal(metrics.cpa, null);
  assert.equal(metrics.cvr, null);
  assert.equal(metrics.roas, 0);
});

test('前月が0なら deltaPct は null', () => {
  const mom = monthOverMonth({ costJpy: 100 }, { costJpy: 0 });
  assert.equal(mom.costJpy.delta, 100);
  assert.equal(mom.costJpy.deltaPct, null);
});

test('前月比は差分と比率を返す', () => {
  const mom = monthOverMonth({ conversions: 60 }, { conversions: 48 });
  assert.equal(mom.conversions.delta, 12);
  assert.equal(mom.conversions.deltaPct, 0.25);
});

test('normalizeAdRows は月で絞り込める', () => {
  assert.equal(normalizeAdRows(adText, { month: '2026-08' }).length, 3);
});

test('manualSteps の手作業合計は145分', () => {
  assert.equal(catalog.manualSteps.reduce((sum, step) => sum + step.minutes, 0), 145);
});

test('summarize は results が空なら未実測になる', () => {
  const summary = summarize({ updatedAt: null, runs: [] }, catalog);
  assert.equal(summary.measured, false);
  assert.equal(summary.savedMinutes, null);
  assert.equal(summary.monthlySavedJpy, null);
  assert.equal(summary.paybackRuns, null);
  assert.equal(summary.verdict, '未実測');
});

test('summarize は run から削減量と回収回数を計算する', () => {
  const summary = summarize({ runs: [{ pipelineMs: 30000, period: '2026-09', previousPeriod: '2026-08' }] }, catalog);
  assert.equal(summary.measured, true);
  assert.equal(summary.manualMinutes, 145);
  assert.equal(summary.residualMinutes, 29);
  assert.equal(summary.machineMinutes, 0.5);
  assert.equal(summary.savedMinutes, 115.5);
  assert.equal(summary.paybackRuns, Math.ceil(180 / 115.5));
});

test('verdictFor は4分岐を順に判定する', () => {
  const base = { measured: true, savedMinutes: 100, savedPct: 0.8, unverified: [] };
  assert.equal(verdictFor({ ...base, measured: false }, catalog).verdict, '未実測');
  assert.equal(verdictFor({ ...base, savedMinutes: 0 }, catalog).verdict, '削減効果なし');
  assert.equal(verdictFor({ ...base, savedPct: 0.1 }, catalog).verdict, '削減は限定的');
  assert.equal(verdictFor({ ...base, unverified: ['narrative'] }, catalog).verdict, '条件付きで有効');
  assert.equal(verdictFor(base, catalog).verdict, '削減有効');
});

test('renderMarkdown は決定的で必須見出しを含む', () => {
  const results = { runs: [{ pipelineMs: 32000, period: '2026-09', previousPeriod: '2026-08' }] };
  const first = renderMarkdown(results, catalog);
  assert.equal(first, renderMarkdown(results, catalog));
  for (const heading of ['# AI支援レポート自動化による人手削減（P-0147）', '## 結論', '## 削減効果', '## 未検証', '## 出典']) {
    assert.ok(first.includes(heading), `${heading} が無い`);
  }
});
