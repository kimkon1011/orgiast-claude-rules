/**
 * track-rpd-quoter-response-time のテスト
 *
 * テスト対象: tools/lib/rpd-quoter-response-report.mjs の generateReport
 * データパターンを差し替えて CSV 内容・統計値を検証する。
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { generateReport, formatStatsText } from '../lib/rpd-quoter-response-report.mjs';

// ── ヘルパー ───────────────────────────────────────────────────
function makeRecord(overrides = {}) {
  const val = (key, def) => overrides[key] !== undefined ? overrides[key] : def;
  return {
    id: val('id', 1),
    deal_id: val('deal_id', 1001),
    quoter_responded_at: val('quoter_responded_at', '2026-11-06T05:00:00+00:00'),
    created_at: val('created_at', '2026-11-06T04:00:00+00:00'),
    is_pre_generated: val('is_pre_generated', false),
    pre_generated_at: val('pre_generated_at', null),
  };
}

// テスト用基準時刻: 2026-11-06T10:00:00+09:00 (= 2026-11-06T01:00:00Z)
const TEST_NOW = new Date('2026-11-06T01:00:00Z');

// ── テスト: CSV に新列が含まれる ──────────────────────────────
test('CSV header includes is_pre_generated and pre_generated_at', () => {
  const records = [
    makeRecord({ id: 1, deal_id: 1001, is_pre_generated: true, pre_generated_at: '2026-11-06T03:30:00+00:00' }),
    makeRecord({ id: 2, deal_id: 1002, is_pre_generated: false, pre_generated_at: null }),
  ];
  const { csv, stats } = generateReport(records, { now: TEST_NOW });
  const lines = csv.trim().split('\n');
  // header
  assert.equal(lines[0], 'deal_id,created_at,quoter_responded_at,latency_seconds,deal_url,is_pre_generated,pre_generated_at');
  // row 1 (pre-generated)
  const cols1 = lines[1].split(',');
  assert.equal(cols1[0], '1001');
  assert.equal(cols1[5], 'true');
  assert.ok(cols1[6].includes('+09:00'), `${cols1[6]} should have JST offset`);
  // row 2 (non-pre-generated)
  const cols2 = lines[2].split(',');
  assert.equal(cols2[0], '1002');
  assert.equal(cols2[5], 'false');
  assert.equal(cols2[6], '');
});

// ── テスト: pregen_rate ─────────────────────────────────────────
test('pregen_rate is correct proportion', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00' }),
    makeRecord({ id: 2, is_pre_generated: true, pre_generated_at: '2026-11-06T03:30:00+00:00' }),
    makeRecord({ id: 3, is_pre_generated: false }),
    makeRecord({ id: 4, is_pre_generated: false }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_rate, 0.5);
  assert.equal(stats.total, 4);
});

test('pregen_rate is 0 when no pregenerated records', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: false }),
    makeRecord({ id: 2, is_pre_generated: false }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_rate, 0);
});

test('pregen_rate is 1 when all are pregenerated', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00' }),
    makeRecord({ id: 2, is_pre_generated: true, pre_generated_at: '2026-11-06T03:30:00+00:00' }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_rate, 1);
});

// ── テスト: pregen_median_latency_seconds ──────────────────────
test('pregen_median_latency_seconds calculates median of pregen→responded', () => {
  // pre_generated_at から quoter_responded_at までの経過秒数
  // record 1: pregen 03:00Z, responded 05:00Z → 7200s
  // record 2: pregen 03:30Z, responded 04:00Z → 1800s
  // median: (1800 + 7200) / 2 = 4500
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00', quoter_responded_at: '2026-11-06T05:00:00+00:00' }),
    makeRecord({ id: 2, is_pre_generated: true, pre_generated_at: '2026-11-06T03:30:00+00:00', quoter_responded_at: '2026-11-06T04:00:00+00:00' }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_median_latency_seconds, 4500);
});

test('pregen_median_latency_seconds is null when no pregen records have response', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-05T03:00:00+00:00', quoter_responded_at: null }),
    makeRecord({ id: 2, is_pre_generated: false }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_median_latency_seconds, null);
});

// ── テスト: pregen_without_quoter_response ─────────────────────
test('pregen_without_quoter_response counts pregen records without response', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-05T03:00:00+00:00', quoter_responded_at: null }),
    makeRecord({ id: 2, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00', quoter_responded_at: '2026-11-06T05:00:00+00:00' }),
    makeRecord({ id: 3, is_pre_generated: false }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_without_quoter_response, 1);
});

test('pregen_without_quoter_response is 0 when all pregen records have response', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00' }),
    makeRecord({ id: 2, is_pre_generated: true, pre_generated_at: '2026-11-06T03:30:00+00:00' }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_without_quoter_response, 0);
});

// ── テスト: pregen_abandoned ───────────────────────────────────
test('pregen_abandoned counts pregen records >72h old without response', () => {
  // TEST_NOW = 2026-11-06T10:00:00+09:00 = 2026-11-06T01:00:00Z
  // 72h = 259200s
  // pregen at 2026-11-02T01:00:00Z = 96h before now → abandoned
  // pregen at 2026-11-05T02:00:00Z = 23h before now → not abandoned
  // pregen at 2026-11-06T03:00:00Z with response → not counted
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-02T01:00:00+00:00', quoter_responded_at: null }),
    makeRecord({ id: 2, is_pre_generated: true, pre_generated_at: '2026-11-05T02:00:00+00:00', quoter_responded_at: null }),
    makeRecord({ id: 3, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00', quoter_responded_at: '2026-11-06T05:00:00+00:00' }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  // Only record 1: pregen at 2026-11-02T01:00:00Z, now 2026-11-06T01:00:00Z = 96h > 72h
  assert.equal(stats.pregen_abandoned, 1);
});

test('pregen_abandoned is 0 when no pregen records exceed 72h', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-05T02:00:00+00:00', quoter_responded_at: null }),
    makeRecord({ id: 2, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00' }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  assert.equal(stats.pregen_abandoned, 0);
});

// ── テスト: timestamp format (JST ISO8601) ─────────────────────
test('timestamps in CSV are JST ISO8601 format', () => {
  // Input UTC: 2026-11-06T00:00:00+00:00 → JST: 2026-11-06T09:00:00+09:00
  const records = [
    makeRecord({
      created_at: '2026-11-06T00:00:00+00:00',
      quoter_responded_at: '2026-11-06T01:00:00+00:00',
      is_pre_generated: true,
      pre_generated_at: '2026-11-05T15:00:00+00:00',
    }),
  ];
  const { csv } = generateReport(records, { now: TEST_NOW });
  const cols = csv.trim().split('\n')[1].split(',');
  // created_at: 2026-11-06T00:00:00Z → JST 2026-11-06T09:00:00+09:00
  assert.match(cols[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  assert.equal(cols[1], '2026-11-06T09:00:00+09:00');
  // quoter_responded_at: 2026-11-06T01:00:00Z → JST 2026-11-06T10:00:00+09:00
  assert.equal(cols[2], '2026-11-06T10:00:00+09:00');
  // pre_generated_at: 2026-11-05T15:00:00Z → JST 2026-11-06T00:00:00+09:00
  assert.equal(cols[6], '2026-11-06T00:00:00+09:00');
});

test('latency_seconds is correct with JST timestamps', () => {
  // created_at 2026-11-06T00:00:00+00:00, quoter_responded_at 2026-11-06T01:30:00+00:00 → 5400s
  const records = [
    makeRecord({
      created_at: '2026-11-06T00:00:00+00:00',
      quoter_responded_at: '2026-11-06T01:30:00+00:00',
    }),
  ];
  const { csv } = generateReport(records, { now: TEST_NOW });
  const cols = csv.trim().split('\n')[1].split(',');
  assert.equal(Number(cols[3]), 5400);
});

// ── テスト: empty records ──────────────────────────────────────
test('generateReport handles empty records', () => {
  const { csv, stats } = generateReport([], { now: TEST_NOW });
  assert.equal(csv.trim(), 'deal_id,created_at,quoter_responded_at,latency_seconds,deal_url,is_pre_generated,pre_generated_at');
  assert.equal(stats.total, 0);
  assert.equal(stats.median_latency_seconds, null);
  assert.equal(stats.p95_latency_seconds, null);
  assert.equal(stats.p99_latency_seconds, null);
  assert.equal(stats.fastest_with_url, null);
  assert.equal(stats.slowest_with_url, null);
  assert.equal(stats.pregen_rate, 0);
  assert.equal(stats.pregen_median_latency_seconds, null);
  assert.equal(stats.pregen_without_quoter_response, 0);
  assert.equal(stats.pregen_abandoned, 0);
});

// ── テスト: formatStatsText output shape ───────────────────────
test('formatStatsText includes pregen stats', () => {
  const records = [
    makeRecord({ id: 1, is_pre_generated: true, pre_generated_at: '2026-11-06T03:00:00+00:00' }),
    makeRecord({ id: 2, is_pre_generated: false }),
  ];
  const { stats } = generateReport(records, { now: TEST_NOW });
  const text = formatStatsText(stats);
  assert.ok(text.includes('pregen_rate:'));
  assert.ok(text.includes('pregen_median_latency_seconds:'));
  assert.ok(text.includes('pregen_without_quoter_response:'));
  assert.ok(text.includes('pregen_abandoned:'));
});

// ── テスト: deal_url generation ─────────────────────────────────
test('deal_url is included when deal_id exists', () => {
  const records = [
    makeRecord({ deal_id: 42 }),
    makeRecord({ deal_id: 0 }),
  ];
  const { csv } = generateReport(records, { now: TEST_NOW });
  const lines = csv.trim().split('\n');
  assert.ok(lines[1].includes('https://aujet.vercel.app/deals/42'));
});