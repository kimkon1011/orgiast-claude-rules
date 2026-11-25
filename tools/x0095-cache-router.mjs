#!/usr/bin/env node
// tools/x0095-cache-router.mjs — X-0095: キャッシュ＋ルーティング＋コスト追跡の統合パイプライン
// gptcache(類似度キャッシュ) + routellm(タスク振り分け) + litellm(支出追跡) の機能を1本に統合。
// ブース制作AIの類似デザイン生成リクエストに対するコスト削減効果を測定する。
//
// 使い方:
//   node tools/x0095-cache-router.mjs --process <JSON>      1件処理
//   node tools/x0095-cache-router.mjs --benchmark           ベンチマーク実行
//   node tools/x0095-cache-router.mjs --stats               集計表示
//   node tools/x0095-cache-router.mjs --budget              予算状況確認
//   node tools/x0095-cache-router.mjs --demo booth-proposal デモ実行（llm-cache-store連携）
//
// 環境変数:
//   X0095_CACHE_DIR       キャッシュ保存先 (既定: ~/.claude/x0095-cache)
//   X0095_BUDGET_MONTHLY  月次予算USD (既定: 50)
//   X0095_BUDGET_ALERT    予算超過アラート率 (既定: 0.8 = 80%)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

// ───────── 外部依存（llm-cache-store / model-router） ─────────

/** @import { lookupCache, storeCache, logRequest, computeStats, readLogs, promptHash, similarity } from './llm-cache-store.mjs' */
let _lcs = null;
async function lcs() {
  if (!_lcs) _lcs = await import('./llm-cache-store.mjs');
  return _lcs;
}

/** @import { classifyTask, ROUTING_TABLE, estimateCost as routeCost } from './model-router.mjs' */
let _mr = null;
async function mr() {
  if (!_mr) _mr = await import('./model-router.mjs');
  return _mr;
}

// ───────── 定数 ─────────

const HOME = process.env.ORGIAST_HOME || os.homedir();
function cacheDir() {
  return process.env.X0095_CACHE_DIR || path.join(HOME, '.claude', 'x0095-cache');
}
function costLedgerFile() { return path.join(cacheDir(), 'cost-ledger.jsonl'); }
function budgetFile() { return path.join(cacheDir(), 'budget.json'); }
function statsFile() { return path.join(cacheDir(), 'stats.json'); }

const MONTHLY_BUDGET_USD = parseFloat(process.env.X0095_BUDGET_MONTHLY || '50');
const BUDGET_ALERT_RATIO = parseFloat(process.env.X0095_BUDGET_ALERT || '0.8');
const BENCHMARK_ITERATIONS = 10;

// モデル別単価（OpenRouter 想定、env 上書き可）
const MODEL_RATES = Object.freeze({
  'deepseek/deepseek-v4-flash': { inputPerM: 0.15, outputPerM: 0.60 },
  'kimi/k2':                    { inputPerM: 0.50, outputPerM: 1.50 },
  'openai/gpt-4o-mini':         { inputPerM: 0.15, outputPerM: 0.60 },
  'openai/gpt-4o':              { inputPerM: 2.50, outputPerM: 10.00 },
  'gemini/gemini-flash':        { inputPerM: 0.10, outputPerM: 0.40 },
  'gemini/gemini-pro':          { inputPerM: 1.50, outputPerM: 5.00 },
});

// 複雑度しきい値（文字数）
const THRESHOLDS = Object.freeze({
  simple: { maxTokens: 200, maxPromptLen: 500 },
  medium: { maxTokens: 800, maxPromptLen: 2000 },
});

// ───────── 初期化 ─────────

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* OK */ }
}

export function initStorage() {
  const dir = cacheDir();
  ensureDir(dir);
  for (const f of [costLedgerFile(), budgetFile(), statsFile()]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, f.endsWith('.json') ? '{}' : '', 'utf8');
  }
}

// ───────── コスト計算 ─────────

/** モデル名から単価を取得。未知モデルは既定値を返す。 */
export function modelRate(model) {
  const rate = MODEL_RATES[model];
  if (rate) return rate;
  // 未知モデル → 平均的コストで推定
  return { inputPerM: 1.00, outputPerM: 3.00 };
}

/** 1リクエストのコスト見積（USD） */
export function estimateCost(inputTokens, outputTokens, model) {
  const rate = modelRate(model);
  return (inputTokens / 1e6) * rate.inputPerM + (outputTokens / 1e6) * rate.outputPerM;
}

// ───────── 複雑度分類 ─────────

/**
 * プロンプトから複雑度を分類。
 * 簡易ルールベース + 既存 model-router の classifyTask を利用。
 */
export function classifyComplexity(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string') return { level: 'simple', confidence: 0, reason: 'empty_prompt' };

  const promptLen = prompt.length;
  const hasComplex = /設計|創造|創作|アーキテクチャ|戦略|トレードオフ|\bdesign\b|\barchitecture\b|\bcreative\b|\bstrategy\b/i.test(prompt);
  const hasSimple = /分類|抽出|定型|仕分け|抜き出|\bclassify\b|\bextract\b|\btemplate\b/i.test(prompt);
  const isLong = promptLen > (options.promptThreshold || THRESHOLDS.medium.maxPromptLen);

  if (hasComplex || isLong) {
    return { level: 'complex', confidence: hasComplex ? 0.85 : 0.65, reason: hasComplex ? 'complex_keyword' : 'long_prompt' };
  }
  if (hasSimple) {
    return { level: 'simple', confidence: 0.85, reason: 'simple_keyword' };
  }
  return { level: 'medium', confidence: 0.6, reason: 'default' };
}

/** 複雑度から最適モデルを選択 */
export function selectModel(classification) {
  const map = {
    simple: 'deepseek/deepseek-v4-flash',
    medium: 'kimi/k2',
    complex: 'openai/gpt-4o',
  };
  const model = map[classification.level] || map.medium;
  return { model, level: classification.level, reason: classification.reason };
}

// ───────── 予算管理 ─────────

/** 今月の支出を取得 */
export function readBudget() {
  try {
    return JSON.parse(fs.readFileSync(budgetFile(), 'utf8'));
  } catch {
    return { months: {} };
  }
}

function writeBudget(b) {
  fs.writeFileSync(budgetFile(), JSON.stringify(b, null, 2), 'utf8');
}

/** 今月の支出キー */
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 当月の支出を取得 */
export function getMonthSpend() {
  const b = readBudget();
  const mk = monthKey();
  if (!b.months || !b.months[mk]) return { usd: 0, requests: 0, cacheHits: 0, cacheMisses: 0 };
  return b.months[mk];
}

/** 支出を記録 */
export function recordSpend(amountUsd, meta = {}) {
  initStorage();
  const b = readBudget();
  if (!b.months) b.months = {};
  const mk = monthKey();
  if (!b.months[mk]) b.months[mk] = { usd: 0, requests: 0, cacheHits: 0, cacheMisses: 0 };
  const month = b.months[mk];
  month.usd = Math.round((month.usd + amountUsd) * 1000) / 1000;
  month.requests++;
  if (meta.cacheHit) month.cacheHits++;
  else month.cacheMisses++;
  writeBudget(b);
}

/** 予算状態チェック */
export function checkBudget() {
  const month = getMonthSpend();
  const used = month.usd;
  const remaining = MONTHLY_BUDGET_USD - used;
  const ratio = used / MONTHLY_BUDGET_USD;
  return {
    monthlyBudgetUsd: MONTHLY_BUDGET_USD,
    spentUsd: used,
    remainingUsd: Math.max(0, remaining),
    usedRatio: Math.round(ratio * 1000) / 10,
    alertTriggered: ratio >= BUDGET_ALERT_RATIO,
    requestCount: month.requests,
    cacheHits: month.cacheHits,
    cacheMisses: month.cacheMisses,
    hitRate: month.requests > 0 ? Math.round((month.cacheHits / month.requests) * 1000) / 10 : 0,
  };
}

// ───────── 1件処理（キャッシュ→ルーティング→コスト記録） ─────────

/**
 * 1件のLLMリクエストをパイプライン処理。
 *
 * @param {object} opts
 * @param {string} opts.prompt - 入力プロンプト
 * @param {string} [opts.model] - 強制モデル（指定時はルーティングをスキップ）
 * @param {number} [opts.inputTokens] - 入力トークン数（不明時は推定）
 * @param {number} [opts.outputTokens] - 出力トークン数（不明時は推定）
 * @param {boolean} [opts.skipCache] - キャッシュをスキップ
 * @param {number} [opts.similarityThreshold] - 類似度しきい値 (0.0〜1.0)
 * @returns {Promise<object>}
 */
export async function processRequest(opts) {
  const { prompt, model: forcedModel, skipCache = false, similarityThreshold = 0.85 } = opts;
  let inputTokens = opts.inputTokens || Math.ceil((prompt?.length || 0) / 4);
  let outputTokens = opts.outputTokens || 400;

  // 1. キャッシュ検索
  if (!skipCache) {
    const cache = await lcs();
    const result = cache.lookupCache(prompt, { similarityThreshold });
    if (result.hit) {
      // キャッシュヒット → コスト0
      recordSpend(0, { cacheHit: true });
      return {
        source: 'cache',
        hash: result.hash,
        response: result.entry.response,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        model: result.entry.model || '',
      };
    }
    // 類似エントリがあれば記録
    if (result.similar && result.similar.length > 0) {
      return {
        source: 'similar-found',
        hash: result.hash,
        similar: result.similar.slice(0, 3),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        model: '',
        note: '類似エントリが見つかりました（しきい値未満）',
      };
    }
  }

  // 2. モデル選択（ルーティング）
  let model, complexity;
  if (forcedModel) {
    model = forcedModel;
    complexity = { level: 'forced', reason: 'user_specified' };
  } else {
    const classification = classifyComplexity(prompt);
    const selection = selectModel(classification);
    model = selection.model;
    complexity = selection;
  }

  // 3. 予算チェック
  const budget = checkBudget();
  if (budget.alertTriggered) {
    return {
      source: 'budget-blocked',
      model,
      complexity: complexity.level,
      inputTokens,
      outputTokens,
      costUsd: 0,
      estimatedCostUsd: estimateCost(inputTokens, outputTokens, model),
      budgetStatus: budget,
      note: '月次予算超過アラート発動中',
    };
  }

  // 4. 模擬レスポンス（実際のLLM呼出しはせず、コスト見積のみ）
  const costUsd = estimateCost(inputTokens, outputTokens, model);
  recordSpend(costUsd, { cacheHit: false });

  return {
    source: 'model',
    model,
    complexity: complexity.level,
    reason: complexity.reason,
    inputTokens,
    outputTokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    latencyMs: complexity.level === 'simple' ? 500 : complexity.level === 'medium' ? 1200 : 2000,
  };
}

/**
 * 処理結果をコスト元帳に記録。
 */
export function logCostRecord(record) {
  initStorage();
  const line = JSON.stringify({
    t: new Date().toISOString(),
    ...record,
  });
  fs.appendFileSync(costLedgerFile(), line + '\n');
}

/**
 * 元帳から集計。
 */
export function computePipelineStats({ since = null } = {}) {
  initStorage();
  const rows = [];
  try {
    const text = fs.readFileSync(costLedgerFile(), 'utf8');
    for (const line of text.trim().split('\n').filter(Boolean)) {
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch { /* ファイルなし */ }

  let filtered = rows;
  if (since) {
    const sinceDate = new Date(since);
    filtered = rows.filter(r => new Date(r.t) >= sinceDate);
  }

  const total = filtered.length;
  let cacheHits = 0, modelCalls = 0, budgetBlocks = 0, similarFound = 0;
  let totalCostUsd = 0, totalTokens = 0;

  for (const r of filtered) {
    switch (r.source) {
      case 'cache': cacheHits++; break;
      case 'model': modelCalls++; totalCostUsd += r.costUsd || 0; totalTokens += (r.inputTokens || 0) + (r.outputTokens || 0); break;
      case 'budget-blocked': budgetBlocks++; break;
      case 'similar-found': similarFound++; break;
    }
  }

  const uncachedCost = modelCalls > 0 ? totalCostUsd : 0;
  const savingsUsd = cacheHits > 0 ? totalCostUsd : 0;

  return {
    totalRequests: total,
    cacheHits,
    modelCalls,
    budgetBlocks,
    similarFound,
    hitRate: total > 0 ? Math.round((cacheHits / total) * 1000) / 10 : 0,
    totalCostUsd: Math.round(totalCostUsd * 1000) / 1000,
    totalTokens,
    estimatedSavingsUsd: Math.round(savingsUsd * 1000) / 1000,
    avgCostPerRequest: total > 0 ? Math.round((totalCostUsd / total) * 1e6) / 1e6 : 0,
  };
}

// ───────── ベンチマーク ─────────

/**
 * ベンチマークシナリオ定義。
 * 展示会ブース制作の典型的なLLMリクエストを模擬。
 */
const BENCHMARK_SCENARIOS = {
  'booth-proposal': {
    title: '展示会ブース提案',
    prefix: 'あなたは展示会ブースのデザイナーです。以下の条件で提案を生成してください。\n- ブースサイズ: 標準小間（2.7m×6m）\n- 構造材: アルミフレーム\n- パネル高さ: 2.5mまで\n',
    variants: [
      { suffix: '新製品「Astra-Sol」展示に最適なブースデザインを提案。ターゲットは法人営業担当者。', complexity: 'medium' },
      { suffix: '商談重視のクローズド空間。商談ブース3卓必要。', complexity: 'medium' },
      { suffix: 'デモ重視、製品を動かせるカウンター2台。', complexity: 'medium' },
      { suffix: '分類: 以下の条件からブースタイプを選び、該当IDのみを返せ。\nA) 商談特化 B) 製品展示 C) ブランディング\n条件: 予算200万、製品数5', complexity: 'simple' },
      { suffix: '抽出: この企画書から制作項目だけを表にまとめよ。\n企画書: 3×3ブース、壁面パネル4枚、カウンター1台、モニター1台、照明', complexity: 'simple' },
      { suffix: '設計フェーズ1: ブース動線設計。入場から商談、展示鑑賞、退出までの導線を3パターン提案し、各パターンのトレードオフを分析。', complexity: 'complex' },
      { suffix: '設計フェーズ2: 上記の動線設計に基づき、壁面パネルの情報設計（アイレベル・フォントサイズ・カテゴリ配置）を策定。', complexity: 'complex' },
      { suffix: 'メール返信案: 展示会出展後のフォローアップメール。見積提示済み、商談前。', complexity: 'medium' },
      { suffix: '定型作業: 出展申込書の必須項目をチェックリスト化せよ。', complexity: 'simple' },
      { suffix: '見積比較: 3社の見積（各150万/180万/220万）を同列比較し、価格差の理由を推定。', complexity: 'medium' },
    ],
  },
  'booth-design': {
    title: 'ブースデザイン仕様',
    prefix: 'ブースデザインの仕様を生成。サイズ、材質、予算制約に基づき最適なデザイン案を提供。\n',
    variants: [
      { suffix: '3×3m小間ブース。壁パネルは白、床はグレーカーペット。予算80万。', complexity: 'simple' },
      { suffix: '6×6mコーナーブース。2層展示。床はフローリング調。予算300万。', complexity: 'complex' },
      { suffix: '9×6m島型ブース。全面オープン。吊り天井あり。予算500万。', complexity: 'complex' },
    ],
  },
};

/**
 * ベンチマークを実行。
 * 各バリアントを (a) キャッシュなし (b) キャッシュあり (c) ルーティングあり で処理し、コスト比較。
 */
export async function runBenchmark({ scenario = 'booth-proposal', iterations = BENCHMARK_ITERATIONS } = {}) {
  const config = BENCHMARK_SCENARIOS[scenario];
  if (!config) throw new Error(`Unknown scenario: ${scenario}. Available: ${Object.keys(BENCHMARK_SCENARIOS).join(', ')}`);

  const logs = [];
  const variants = config.variants;

  for (let i = 0; i < Math.min(iterations, variants.length); i++) {
    const variant = variants[i];
    const prompt = config.prefix + '\n\n' + variant.suffix;
    const inputTokens = Math.ceil(prompt.length / 4) + 50;
    const outputTokens = variant.complexity === 'simple' ? 200 : variant.complexity === 'complex' ? 800 : 400;

    const t0 = Date.now();

    // a) キャッシュなし → 直接モデル呼出し想定
    const rawModel = variant.complexity === 'simple' ? 'openai/gpt-4o-mini'
      : variant.complexity === 'complex' ? 'openai/gpt-4o'
      : 'kimi/k2';
    const rawCost = estimateCost(inputTokens, outputTokens, rawModel);

    // b) キャッシュありパイプライン
    // 1回目は必ずミス、2回目以降は同一プロンプトを再利用してヒット
    const cacheResult = await processRequest({ prompt, similarityThreshold: 0.85 });

    // c) ルーティングあり（キャッシュミス時、適切なモデルへ振り分け）
    const classification = classifyComplexity(prompt);
    const routedModel = selectModel(classification).model;
    const routedCost = estimateCost(inputTokens, outputTokens, routedModel);

    const elapsed = Date.now() - t0;

    const logEntry = {
      t: new Date(t0).toISOString(),
      iteration: i,
      variant: variant.suffix.slice(0, 60),
      complexity: variant.complexity,
      inputTokens,
      outputTokens,
      rawModel,
      rawCostUsd: Math.round(rawCost * 1e6) / 1e6,
      cacheSource: cacheResult.source,
      routedModel,
      routedCostUsd: Math.round(routedCost * 1e6) / 1e6,
      savingsPercent: rawCost > 0 ? Math.round((1 - routedCost / rawCost) * 1000) / 10 : 0,
      elapsedMs: elapsed,
    };
    logs.push(logEntry);

    // 結果を元帳に記録
    logCostRecord({
      source: cacheResult.source,
      model: cacheResult.source === 'cache' ? '' : routedModel,
      complexity: variant.complexity,
      inputTokens,
      outputTokens,
      costUsd: cacheResult.source === 'cache' ? 0 : routedCost,
    });
  }

  // 集計
  const totalRaw = logs.reduce((s, l) => s + l.rawCostUsd, 0);
  const totalRouted = logs.reduce((s, l) => s + l.routedCostUsd, 0);
  const totalSavings = totalRaw - totalRouted;
  const cacheHits = logs.filter(l => l.cacheSource === 'cache' || l.cacheSource === 'similar-found').length;

  // 複雑度別集計
  const byComplexity = {};
  for (const l of logs) {
    if (!byComplexity[l.complexity]) byComplexity[l.complexity] = { count: 0, rawCost: 0, routedCost: 0 };
    byComplexity[l.complexity].count++;
    byComplexity[l.complexity].rawCost += l.rawCostUsd;
    byComplexity[l.complexity].routedCost += l.routedCostUsd;
  }

  return {
    scenario: config.title,
    totalRequests: logs.length,
    cacheHits,
    uniqueRequests: logs.length,
    totalRawCostUsd: Math.round(totalRaw * 1000) / 1000,
    totalRoutedCostUsd: Math.round(totalRouted * 1000) / 1000,
    totalSavingsUsd: Math.round(totalSavings * 1000) / 1000,
    savingsPercent: totalRaw > 0 ? Math.round((totalSavings / totalRaw) * 1000) / 10 : 0,
    byComplexity,
    logs,
  };
}

// ───────── CLI ─────────

function printHelp() {
  console.log(`X-0095: キャッシュ＋ルーティング＋コスト追跡 統合パイプライン

使い方:
  node tools/x0095-cache-router.mjs --process <JSON>
      1件のLLMリクエストを処理（キャッシュ→ルーティング→コスト記録）
      JSON: {"prompt":"...","model?":"...","skipCache?":true/false}

  node tools/x0095-cache-router.mjs --benchmark [--scenario booth-proposal|booth-design] [--iterations N]
      ベンチマーク実行（キャッシュ・ルーティングのコスト比較）

  node tools/x0095-cache-router.mjs --stats [--since YYYY-MM-DD]
      パイプライン集計

  node tools/x0095-cache-router.mjs --budget
      予算状況確認

  node tools/x0095-cache-router.mjs --demo booth-proposal
      llm-cache-store のデモシナリオを実行（--scenario を指定可）

  node tools/x0095-cache-router.mjs --help
      このヘルプ

環境変数:
  X0095_CACHE_DIR      キャッシュ保存先
  X0095_BUDGET_MONTHLY 月次予算USD (既定: 50)
  X0095_BUDGET_ALERT   予算超過アラート率 (既定: 0.8)
`);
}

async function main() {
  const args = process.argv.slice(2);
  initStorage();

  if (args.includes('--help') || args.length === 0) { printHelp(); return; }

  // --process: 1件処理
  if (args.includes('--process')) {
    const idx = args.indexOf('--process');
    const jsonStr = idx + 1 < args.length ? args[idx + 1] : '';
    if (!jsonStr) { console.error('--process requires JSON argument'); process.exit(2); }
    let opts;
    try { opts = JSON.parse(jsonStr); } catch { console.error('Invalid JSON'); process.exit(2); }
    const result = await processRequest(opts);
    const record = { ...result, inputTokens: opts.inputTokens, outputTokens: opts.outputTokens };
    logCostRecord(record);
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  // --demo: llm-cache-store デモ（既存機能）
  if (args.includes('--demo')) {
    const cache = await lcs();
    const scenarioArg = args.find(a => a.startsWith('--scenario='))?.split('=')[1] || '';
    const scenario = scenarioArg || 'booth-proposal';
    const result = cache.runDemo({ scenario, batchSize: 5 });
    console.log(JSON.stringify(result, null, 2));

    // ルーティング比較を追加表示
    console.log('\n=== ルーティング比較（各リクエストの最適モデル）===');
    for (const log of result.logs) {
      const classification = classifyComplexity(log.prompt);
      const selection = selectModel(classification);
      console.log(`  [${classification.level}] ${String(log.prompt).slice(0, 60)}... → ${selection.model}`);
    }
    return;
  }

  // --benchmark: ベンチマーク
  if (args.includes('--benchmark')) {
    const scenarioArg = args.find(a => a.startsWith('--scenario='))?.split('=')[1] || 'booth-proposal';
    const iterIdx = args.indexOf('--iterations');
    const iterations = iterIdx >= 0 && iterIdx + 1 < args.length ? parseInt(args[iterIdx + 1], 10) || BENCHMARK_ITERATIONS : BENCHMARK_ITERATIONS;
    const result = await runBenchmark({ scenario: scenarioArg, iterations });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // --stats: 集計
  if (args.includes('--stats')) {
    const sinceIdx = args.indexOf('--since');
    const since = sinceIdx >= 0 && sinceIdx + 1 < args.length ? args[sinceIdx + 1] : null;
    const stats = computePipelineStats({ since });
    console.log(JSON.stringify(stats, null, 2));
    console.log(`\n--- X-0095 パイプライン集計 ---`);
    console.log(`総リクエスト: ${stats.totalRequests}`);
    console.log(`キャッシュヒット: ${stats.cacheHits} (${stats.hitRate}%)`);
    console.log(`モデル呼出し: ${stats.modelCalls}`);
    console.log(`予算ブロック: ${stats.budgetBlocks}`);
    console.log(`類似発見: ${stats.similarFound}`);
    console.log(`総コスト: $${stats.totalCostUsd}`);
    console.log(`推定削減額: $${stats.estimatedSavingsUsd}`);
    return;
  }

  // --budget: 予算状況
  if (args.includes('--budget')) {
    const status = checkBudget();
    console.log(JSON.stringify(status, null, 2));
    console.log(`\n--- 予算状況 ---`);
    console.log(`月次予算: $${status.monthlyBudgetUsd}`);
    console.log(`当月支出: $${status.spentUsd}`);
    console.log(`残り: $${status.remainingUsd}`);
    console.log(`使用率: ${status.usedRatio}%`);
    console.log(`ヒット率: ${status.hitRate}%`);
    if (status.alertTriggered) console.log('⚠️ 予算超過アラート発動中');
    return;
  }

  printHelp();
}

if (isEntry(import.meta.url)) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}