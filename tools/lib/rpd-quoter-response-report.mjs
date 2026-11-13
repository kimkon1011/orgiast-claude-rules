/**
 * rpd-quoter-response-report.mjs — 見積り応答時間レポート生成
 *
 * 公開:
 *   generateReport(records, options?) => { csv, stats }
 *
 * records: Array<{
 *   id: number,
 *   deal_id: number,
 *   quoter_responded_at: string|null (ISO8601),
 *   created_at: string (ISO8601),
 *   is_pre_generated: boolean,
 *   pre_generated_at: string|null (ISO8601)
 * }>
 *
 * options.now: Date — テスト用の基準時刻（省略時は new Date()）。abandoned 判定に使う。
 */

import { strict as assert } from 'node:assert';

// ── タイムスタンプ整形 ──────────────────────────────────────────
// JST (UTC+9) に変換し ISO8601 で返す（例: 2025-01-15T10:00:00+09:00）
function toJstIso(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const jst = new Date(d.getTime() + 9 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}+09:00`;
}

// ── 統計補助 ────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  if (Number.isInteger(mid)) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[Math.floor(mid)];
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * @param {Array} records
 * @param {{ now?: Date }} options
 * @returns {{ csv: string, stats: object }}
 */
export function generateReport(records, options = {}) {
  const now = options.now ?? new Date();
  const SEVENTY_TWO_HOURS_MS = 72 * 3600_000;

  // ── CSV 行 ──────────────────────────────────────────────────
  const header = 'deal_id,created_at,quoter_responded_at,latency_seconds,deal_url,is_pre_generated,pre_generated_at';
  const rows = records.map((r) => {
    const created = toJstIso(r.created_at);
    const responded = toJstIso(r.quoter_responded_at);
    const latencySec = r.quoter_responded_at
      ? Math.round((new Date(r.quoter_responded_at).getTime() - new Date(r.created_at).getTime()) / 1000)
      : '';
    const dealUrl = r.deal_id ? `https://aujet.vercel.app/deals/${r.deal_id}` : '';
    const pregen = r.is_pre_generated ? 'true' : 'false';
    const pregenAt = toJstIso(r.pre_generated_at);
    return `${r.deal_id},${created},${responded},${latencySec},${dealUrl},${pregen},${pregenAt}`;
  });

  const csv = [header, ...rows].join('\n') + '\n';

  // ── 既存統計値 ──────────────────────────────────────────────
  const latencies = records
    .filter((r) => r.quoter_responded_at)
    .map((r) => Math.round((new Date(r.quoter_responded_at).getTime() - new Date(r.created_at).getTime()) / 1000))
    .sort((a, b) => a - b);

  const total = records.length;
  const medianLatencySeconds = median(latencies);
  const p95LatencySeconds = percentile(latencies, 95);
  const p99LatencySeconds = percentile(latencies, 99);

  // 最速・最遅 (deal_url 付き)
  const withUrl = records.filter((r) => r.quoter_responded_at && r.deal_id);
  let fastestWithUrl = null;
  let slowestWithUrl = null;
  if (withUrl.length > 0) {
    withUrl.sort((a, b) => {
      const la = new Date(a.quoter_responded_at).getTime() - new Date(a.created_at).getTime();
      const lb = new Date(b.quoter_responded_at).getTime() - new Date(b.created_at).getTime();
      return la - lb;
    });
    const fastest = withUrl[0];
    const slowest = withUrl[withUrl.length - 1];
    const fastestSec = Math.round((new Date(fastest.quoter_responded_at).getTime() - new Date(fastest.created_at).getTime()) / 1000);
    const slowestSec = Math.round((new Date(slowest.quoter_responded_at).getTime() - new Date(slowest.created_at).getTime()) / 1000);
    fastestWithUrl = { seconds: fastestSec, url: `https://aujet.vercel.app/deals/${fastest.deal_id}` };
    slowestWithUrl = { seconds: slowestSec, url: `https://aujet.vercel.app/deals/${slowest.deal_id}` };
  }

  // ── 事前生成統計値 ──────────────────────────────────────────
  const pregenRecords = records.filter((r) => r.is_pre_generated);
  const pregenRate = total > 0 ? pregenRecords.length / total : 0;

  // pre_generated_at → quoter_responded_at の経過秒数（中央値）
  const pregenLatencies = pregenRecords
    .filter((r) => r.pre_generated_at && r.quoter_responded_at)
    .map((r) => Math.round((new Date(r.quoter_responded_at).getTime() - new Date(r.pre_generated_at).getTime()) / 1000))
    .sort((a, b) => a - b);
  const pregenMedianLatencySeconds = median(pregenLatencies);

  // 事前生成されたがまだ quoter 応答が無い
  const pregenWithoutQuoterResponse = pregenRecords.filter((r) => !r.quoter_responded_at).length;

  // 事前生成から 72 時間経過しても応答が無い
  const pregenAbandoned = pregenRecords.filter((r) => {
    if (r.quoter_responded_at) return false;
    if (!r.pre_generated_at) return false;
    const elapsed = now.getTime() - new Date(r.pre_generated_at).getTime();
    return elapsed >= SEVENTY_TWO_HOURS_MS;
  }).length;

  const stats = {
    total,
    median_latency_seconds: medianLatencySeconds,
    p95_latency_seconds: p95LatencySeconds,
    p99_latency_seconds: p99LatencySeconds,
    fastest_with_url: fastestWithUrl,
    slowest_with_url: slowestWithUrl,
    pregen_rate: pregenRate,
    pregen_median_latency_seconds: pregenMedianLatencySeconds,
    pregen_without_quoter_response: pregenWithoutQuoterResponse,
    pregen_abandoned: pregenAbandoned,
  };

  return { csv, stats };
}

/** CSV 行をフォーマットして出力（テスト用） */
export function formatStatsText(stats) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const sec = (v) => v == null ? 'null' : `${v}`;
  const lines = [
    `total: ${stats.total}`,
    `median_latency_seconds: ${sec(stats.median_latency_seconds)}`,
    `p95_latency_seconds: ${sec(stats.p95_latency_seconds)}`,
    `p99_latency_seconds: ${sec(stats.p99_latency_seconds)}`,
    `fastest_with_url: ${stats.fastest_with_url ? `${stats.fastest_with_url.seconds}s ${stats.fastest_with_url.url}` : 'null'}`,
    `slowest_with_url: ${stats.slowest_with_url ? `${stats.slowest_with_url.seconds}s ${stats.slowest_with_url.url}` : 'null'}`,
    `pregen_rate: ${pct(stats.pregen_rate)}`,
    `pregen_median_latency_seconds: ${sec(stats.pregen_median_latency_seconds)}`,
    `pregen_without_quoter_response: ${stats.pregen_without_quoter_response}`,
    `pregen_abandoned: ${stats.pregen_abandoned}`,
  ];
  return lines.join('\n');
}