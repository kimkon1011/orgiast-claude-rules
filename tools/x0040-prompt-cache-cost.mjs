#!/usr/bin/env node
/**
 * X-0040: プロンプトキャッシュコスト計算CLI
 *
 * Claude API（Fable 5.2）のプロンプトキャッシュ機能を使った、
 * 繰り返し問い合わせのコストを計算する決定論的ツール。
 * 外部APIを一切呼ばない。
 *
 * 使用法:
 *   node tools/x0040-prompt-cache-cost.mjs
 *   node tools/x0040-prompt-cache-cost.mjs --turns 100 --output 50
 */

// Fable 5.2 の実価格（2026-11-18 時点）
const MODELS = {
  'fable-5-2': {
    name: 'Fable 5.2',
    // 入力トークン単価（/1M Tok）
    input: 8.00,
    // 出力トークン単価（/1M Tok）
    output: 75.00,
    // キャッシュ書き込み単価（/1M Tok）: 入力単価 × 1.25（書込サーチャージ $2.00 加算）
    cacheWrite: 10.00,
    // キャッシュ読み取り単価（/1M Tok）: 入力単価 × 0.025（キャッシュヒット割引後 $0.20）
    cacheRead: 0.20,
  },
};

/** プロンプトキャッシュTTL（ミリ秒） */
const CACHE_TTL_MS = 300_000; // 5分

/**
 * コスト計算の中心関数。
 *
 * @param {object} opts
 * @param {string}  opts.model        - モデル名（デフォルト 'fable-5-2'）
 * @param {number}  opts.totalTokens  - 1ターンあたりの総入力トークン数
 * @param {number}  opts.cacheTokens  - キャッシュ対象プレフィックスのトークン数
 * @param {number}  opts.outputTokens - 1ターンあたりの出力トークン数（0 = 出力はコスト計算に含めない）
 * @param {number}  opts.turns        - 総ターン数
 * @param {number}  opts.intervalMs   - ターン間隔（ミリ秒）。300_000超でキャッシュ期限切れ
 * @param {number[]} opts.prefixChanges - プレフィックス変更が起きるターン番号（1-indexed）の配列
 * @returns {object} 計算結果
 */
export function calculateCost({
  model = 'fable-5-2',
  totalTokens = 80000,
  cacheTokens = 80000,
  outputTokens = 0,
  turns = 50,
  intervalMs = 240000,
  prefixChanges = [],
} = {}) {
  const p = MODELS[model];
  if (!p) throw new Error(`Unknown model: ${model}`);
  if (cacheTokens > totalTokens) {
    throw new Error(
      `cacheTokens (${cacheTokens}) は totalTokens (${totalTokens}) を超えられません`
    );
  }

  const cacheExpired = intervalMs > CACHE_TTL_MS;
  const nonCacheTokens = totalTokens - cacheTokens;

  // キャッシュなしの場合のコスト（比較用）
  const uncachedTotal =
    turns * (totalTokens * p.input + outputTokens * p.output) / 1_000_000;

  let cachedTotal = 0;
  const breakdown = [];

  for (let t = 1; t <= turns; t++) {
    const isFirst = t === 1;
    const isExpired = !isFirst && cacheExpired;
    const isPrefixChange = !isFirst && prefixChanges.includes(t);

    // キャッシュ適用コスト
    let cacheCost;
    if (isFirst || isExpired || isPrefixChange) {
      // 初回、期限切れ、またはプレフィックス変更: キャッシュ書込単価で計算
      cacheCost =
        (cacheTokens * p.cacheWrite + nonCacheTokens * p.input) / 1_000_000;
    } else {
      // 2回目以降（キャッシュ有効）: キャッシュ読取単価で計算
      cacheCost =
        (cacheTokens * p.cacheRead + nonCacheTokens * p.input) / 1_000_000;
    }

    const outputCost = (outputTokens * p.output) / 1_000_000;
    const turnCost = cacheCost + outputCost;
    cachedTotal += turnCost;

    // phase 判定
    let phase;
    if (isFirst) {
      phase = 'cache_write';
    } else if (isExpired) {
      phase = 'cache_write_expired';
    } else if (isPrefixChange) {
      phase = 'cache_write_prefix_changed';
    } else {
      phase = 'cache_read';
    }

    breakdown.push({
      turn: t,
      phase,
      cacheCost: round6(cacheCost),
      outputCost: round6(outputCost),
      subtotal: round6(turnCost),
      cumulative: round6(cachedTotal),
    });
  }

  const savingsRate = 1 - cachedTotal / uncachedTotal;

  return {
    model,
    modelLabel: p.name,
    inputPricePerM: p.input,
    outputPricePerM: p.output,
    cacheWritePricePerM: p.cacheWrite,
    cacheReadPricePerM: p.cacheRead,
    totalTokens,
    cacheTokens,
    nonCacheTokens,
    outputTokens,
    turns,
    intervalMs,
    cacheExpired,
    uncachedTotal: round6(uncachedTotal),
    cachedTotal: round6(cachedTotal),
    savingsRate: round4(savingsRate),
    roundedTotal: round2(cachedTotal),
    breakdown,
  };
}

// ── ヘルパー ────────────────────────────────────────────

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function round6(n) {
  return round(n, 6);
}
function round4(n) {
  return round(n, 4);
}
function round2(n) {
  return round(n, 2);
}

// ── CLI エントリポイント ─────────────────────────────────

import { fileURLToPath } from 'url';
import { resolve } from 'path';
// process.argv[1] は相対パスのこともあるので絶対パスに解決して比較
const thisFileNormalized = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const invokedNormalized = process.argv[1]
  ? resolve(process.cwd(), process.argv[1]).replace(/\\/g, '/')
  : '';
const isDirectRun = thisFileNormalized === invokedNormalized;

if (isDirectRun) {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
        opts.model = args[++i];
        break;
      case '--total':
        opts.totalTokens = Number(args[++i]);
        break;
      case '--cache':
        opts.cacheTokens = Number(args[++i]);
        break;
      case '--output':
        opts.outputTokens = Number(args[++i]);
        break;
      case '--turns':
        opts.turns = Number(args[++i]);
        break;
      case '--interval':
        opts.intervalMs = Number(args[++i]);
        break;
      case '--json':
        // デフォルトがJSONなので何もしない
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  const result = calculateCost(opts);
  console.log(JSON.stringify(result, null, 2));
}
