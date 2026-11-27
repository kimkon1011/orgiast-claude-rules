#!/usr/bin/env node
// trace-send.mjs — 軽量トレース記録（Langfuse / Arize Phoenix のセルフホスト版への移行パス）
// エージェントの実行結果を JSONL で永続化し、週次レポートを生成する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const TRACE_DIR = path.join(os.homedir(), '.claude', 'traces');

/**
 * 1件のトレースイベントを記録する。
 * @param {object} opts
 * @param {string} opts.name — トレース名（例: 'booth-proposal-gen'）
 * @param {string} [opts.model] — 使用モデル
 * @param {number} [opts.inTok] — 入力トークン数
 * @param {number} [opts.outTok] — 出力トークン数
 * @param {number} [opts.durationMs] — 実行時間（ミリ秒）
 * @param {number} [opts.costUsd] — コスト（USD）
 * @param {number} [opts.score] — 評価スコア（0〜1）
 * @param {boolean} [opts.passed] — 評価合格フラグ
 * @param {string} [opts.provider] — プロバイダ名
 * @param {string} [opts.sessionId] — セッションID
 * @param {string} [opts.outputPath] — 出力ファイルパス
 * @returns {object} 記録されたトレースオブジェクト
 */
export function traceEvent(opts = {}) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const dir = path.join(TRACE_DIR, dateStr);
  fs.mkdirSync(dir, { recursive: true });

  const record = {
    t: new Date().toISOString(),
    name: opts.name || 'unnamed',
    model: opts.model || null,
    provider: opts.provider || null,
    sessionId: opts.sessionId || null,
    inTok: typeof opts.inTok === 'number' ? opts.inTok : null,
    outTok: typeof opts.outTok === 'number' ? opts.outTok : null,
    durationMs: typeof opts.durationMs === 'number' ? opts.durationMs : null,
    costUsd: typeof opts.costUsd === 'number' ? opts.costUsd : null,
    score: typeof opts.score === 'number' ? opts.score : null,
    passed: opts.passed === true ? true : opts.passed === false ? false : null,
    outputPath: opts.outputPath || null,
  };

  fs.appendFileSync(path.join(dir, 'traces.jsonl'), JSON.stringify(record) + '\n');
  return record;
}

/**
 * 指定日のトレース一覧を読む。
 * @param {string} dateStr — 'YYYY-MM-DD' 形式。省略時は本日。
 * @returns {object[]}
 */
export function readTraces(dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  const file = path.join(TRACE_DIR, d, 'traces.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * 直近N日間のトレースを集計する。
 * @param {number} [days=7]
 * @returns {object}
 */
export function weeklyReport({ days = 7 } = {}) {
  const traces = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    traces.push(...readTraces(d.toISOString().slice(0, 10)));
  }

  const total = traces.length;
  const passed = traces.filter(t => t.passed === true).length;
  const failed = traces.filter(t => t.passed === false).length;
  const ungraded = total - passed - failed;
  const totalCost = traces.reduce((s, t) => s + (t.costUsd || 0), 0);
  const durations = traces.filter(t => typeof t.durationMs === 'number').map(t => t.durationMs);
  const avgDuration = durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : 0;

  // プロバイダ別集計
  const byProvider = {};
  for (const t of traces) {
    const p = t.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = { count: 0, costUsd: 0, passed: 0, failed: 0 };
    byProvider[p].count++;
    byProvider[p].costUsd += t.costUsd || 0;
    if (t.passed === true) byProvider[p].passed++;
    if (t.passed === false) byProvider[p].failed++;
  }

  // 名前別集計
  const byName = {};
  for (const t of traces) {
    const n = t.name || 'unnamed';
    if (!byName[n]) byName[n] = { count: 0, passed: 0, failed: 0, avgScore: 0, scores: [] };
    byName[n].count++;
    if (t.passed === true) byName[n].passed++;
    if (t.passed === false) byName[n].failed++;
    if (typeof t.score === 'number') byName[n].scores.push(t.score);
  }
  for (const n of Object.keys(byName)) {
    const s = byName[n].scores;
    byName[n].avgScore = s.length ? s.reduce((a, v) => a + v, 0) / s.length : null;
    delete byName[n].scores;
  }

  return {
    period: `直近${days}日間`,
    totalTraces: total,
    passRate: total && (passed + failed) ? ((passed / (passed + failed)) * 100).toFixed(1) + '%' : 'N/A',
    passed,
    failed,
    ungraded,
    totalCostUsd: Number(totalCost.toFixed(6)),
    avgDurationMs: avgDuration,
    byProvider,
    byName,
  };
}

// CLI
if (isEntry(import.meta.url)) {
  const cmd = process.argv[2];

  if (cmd === 'report') {
    const days = parseInt(process.argv[3], 10) || 7;
    const report = weeklyReport({ days });
    console.log(JSON.stringify(report, null, 2));
  } else if (cmd === 'read') {
    const dateStr = process.argv[3];
    const traces = readTraces(dateStr);
    console.log(JSON.stringify(traces, null, 2));
  } else if (cmd === 'send' || !cmd) {
    // 引数なしまたは send: 標準入力からJSONを受け取って記録
    let body = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { body += chunk; });
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(body);
        const records = Array.isArray(data) ? data : [data];
        const results = records.map(r => traceEvent(r));
        console.log(JSON.stringify({ ok: true, count: results.length }, null, 2));
      } catch (e) {
        console.error(JSON.stringify({ ok: false, error: e.message }));
        process.exit(1);
      }
    });
  } else {
    console.error(`使い方:
  node tools/trace-send.mjs                    # 標準入力のJSONを記録
  node tools/trace-send.mjs send               # 同上
  node tools/trace-send.mjs report [days=7]    # 週次レポート
  node tools/trace-send.mjs read [YYYY-MM-DD]  # 指定日のトレース一覧`);
    process.exit(2);
  }
}
