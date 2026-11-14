#!/usr/bin/env node
// grok-monitor-cost-model.mjs — Grok監視頻度最適化のコスト削減率を計算するCLI
// X-0020: 監視頻度3段階化と差分処理でGrokコスト削減
//
// 使い方:
//   node tools/grok-monitor-cost-model.mjs                     # デフォルト値で全シナリオ表示
//   node tools/grok-monitor-cost-model.mjs --scenario basic    # 特定シナリオのみ表示
//   node tools/grok-monitor-cost-model.mjs --list              # シナリオ一覧
//   node tools/grok-monitor-cost-model.mjs --json              # JSON形式で出力

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === 型定義 ===

/**
 * @typedef {Object} TierConfig
 * @property {string} label - ティア名
 * @property {number} intervalMinutes - チェック間隔（分）
 * @property {number} checksPerDay - 1日あたりチェック回数
 * @property {number} changeRate - 変化発生確率（0.0-1.0）
 * @property {number} aiCostPerCall - AI分析1回あたりコスト（USD）
 */

/**
 * @typedef {Object} Scenario
 * @property {string} label - シナリオ名
 * @property {string} description - 説明
 * @property {number} baselineChecksPerDay - 改善前の1日あたりチェック回数
 * @property {number} baselineAiCallsPerDay - 改善前の1日あたりAI分析回数
 * @property {number} baselineCostPerCheck - 改善前のチェック1回あたりコスト
 * @property {TierConfig[]} tiers - 改善後のティア構成
 * @property {boolean} useTimeBased - 時間帯別頻度を使用するか
 * @property {number} businessHourRatio - 営業時間比率（0.0-1.0）
 * @property {number} businessIntervalMinutes - 営業時間中の間隔（分）
 * @property {number} offHourIntervalMinutes - 時間外の間隔（分）
 * @property {number} maxItemsPerRun - 1回の最大処理数
 */

// === デフォルト設定 ===

const DEFAULT_PARAMS = {
  baselineChecksPerDay: 1440,     // 1分間隔 × 24時間 = 1,440回
  baselineAiCallsPerDay: 1440,    // 毎回AI分析
  baselineCostPerCheck: 0.002,    // チェック1回あたりコスト（Grok API call）
  baselineAiCostPerCall: 0.01,    // AI分析1回あたりコスト
  businessIntervalMinutes: 15,    // 営業時間中の間隔
  offHourIntervalMinutes: 60,    // 時間外の間隔
  businessHoursPerDay: 9,         // 営業時間（9時間 = 9:00-18:00）
  maxItemsPerRun: 10,             // 1回の最大処理数
};

// === シナリオ定義 ===

/** @type {Scenario[]} */
const SCENARIOS = [
  {
    label: 'basic',
    description: '基本: 1分→15分 一律変更。変化なしでもAI分析する',
    baselineChecksPerDay: 1440,
    baselineAiCallsPerDay: 1440,
    baselineCostPerCheck: 0.002,
    tiers: [
      { label: '全対象', intervalMinutes: 15, checksPerDay: 96, changeRate: 1.0, aiCostPerCall: 0 },
    ],
    useTimeBased: false,
    businessHourRatio: 1,
    businessIntervalMinutes: 15,
    offHourIntervalMinutes: 60,
    maxItemsPerRun: 999,
  },
  {
    label: 'tiered',
    description: '3段階: 緊急5分/通常15分/収集12時間。変化時のみAI分析',
    baselineChecksPerDay: 1440 * 3, // 3対象
    baselineAiCallsPerDay: 1440 * 3,
    baselineCostPerCheck: 0.002,
    tiers: [
      { label: '緊急', intervalMinutes: 5, checksPerDay: 288, changeRate: 0.3, aiCostPerCall: 0.01 },
      { label: '通常', intervalMinutes: 15, checksPerDay: 96, changeRate: 0.1, aiCostPerCall: 0.01 },
      { label: '収集', intervalMinutes: 720, checksPerDay: 2, changeRate: 0.05, aiCostPerCall: 0.01 },
    ],
    useTimeBased: false,
    businessHourRatio: 1,
    businessIntervalMinutes: 15,
    offHourIntervalMinutes: 60,
    maxItemsPerRun: 10,
  },
  {
    label: 'timed-tiered',
    description: '時間帯別＋3段階: 営業中は15分/時間外60分。3段階＋変化時のみAI',
    baselineChecksPerDay: 1440 * 3,
    baselineAiCallsPerDay: 1440 * 3,
    baselineCostPerCheck: 0.002,
    tiers: [
      { label: '緊急', intervalMinutes: 5, checksPerDay: 288, changeRate: 0.3, aiCostPerCall: 0.01 },
      { label: '通常', intervalMinutes: 15, checksPerDay: 96, changeRate: 0.1, aiCostPerCall: 0.01 },
      { label: '収集', intervalMinutes: 720, checksPerDay: 2, changeRate: 0.05, aiCostPerCall: 0.01 },
    ],
    useTimeBased: true,
    businessHourRatio: 9 / 24,
    businessIntervalMinutes: 15,
    offHourIntervalMinutes: 60,
    maxItemsPerRun: 10,
  },
  {
    label: 'aggressive',
    description: '積極削減: 時間帯別＋3段階＋深夜停止＋変化時のみAI＋上限10件',
    baselineChecksPerDay: 1440 * 3,
    baselineAiCallsPerDay: 1440 * 3,
    baselineCostPerCheck: 0.002,
    tiers: [
      { label: '緊急', intervalMinutes: 5, checksPerDay: 288, changeRate: 0.3, aiCostPerCall: 0.01 },
      { label: '通常', intervalMinutes: 30, checksPerDay: 48, changeRate: 0.1, aiCostPerCall: 0.01 },
      { label: '収集', intervalMinutes: 720, checksPerDay: 2, changeRate: 0.05, aiCostPerCall: 0.01 },
    ],
    useTimeBased: true,
    businessHourRatio: 9 / 24,
    businessIntervalMinutes: 30,
    offHourIntervalMinutes: 120,
    maxItemsPerRun: 10,
  },
  {
    label: 'event-emergency',
    description: 'イベント期間: 顧客問い合わせのみ緊急5分、通常15分、収集12時間＋時間帯別',
    baselineChecksPerDay: 1440 * 3,
    baselineAiCallsPerDay: 1440 * 3,
    baselineCostPerCheck: 0.002,
    tiers: [
      { label: '顧客問い合わせ(緊急)', intervalMinutes: 5, checksPerDay: 288, changeRate: 0.5, aiCostPerCall: 0.01 },
      { label: 'SNS反応(通常)', intervalMinutes: 15, checksPerDay: 96, changeRate: 0.2, aiCostPerCall: 0.01 },
      { label: '競合情報(収集)', intervalMinutes: 720, checksPerDay: 2, changeRate: 0.05, aiCostPerCall: 0.01 },
    ],
    useTimeBased: true,
    businessHourRatio: 12 / 24,
    businessIntervalMinutes: 5,
    offHourIntervalMinutes: 30,
    maxItemsPerRun: 20,
  },
];

// === 計算関数 ===

/**
 * 改善前の1日コストを計算
 * @param {Scenario} scenario
 * @param {object} [params]
 * @returns {number}
 */
function baselineDailyCost(scenario, params = DEFAULT_PARAMS) {
  const aiCostPerCall = scenario.baselineAiCostPerCall ?? params.baselineAiCostPerCall;
  return scenario.baselineChecksPerDay * scenario.baselineCostPerCheck
    + scenario.baselineAiCallsPerDay * aiCostPerCall;
}

/**
 * 改善後の1日コストを計算
 * @param {Scenario} scenario
 * @param {object} params
 * @returns {{ cost: number, checksPerDay: number, aiCallsPerDay: number, details: object }}
 */
function improvedDailyCost(scenario, params = DEFAULT_PARAMS) {
  let totalChecksPerDay = 0;
  let totalAiCallsPerDay = 0;
  let totalCost = 0;
  const tierDetails = [];

  for (const tier of scenario.tiers) {
    let checksPerDay = tier.checksPerDay;

    // 時間帯別頻度の適用
    if (scenario.useTimeBased) {
      const businessRatio = scenario.businessHourRatio;
      const offHourRatio = 1 - businessRatio;

      const businessChecks = (24 * businessRatio * 60) / scenario.businessIntervalMinutes;
      const offHourChecks = (24 * offHourRatio * 60) / scenario.offHourIntervalMinutes;
      checksPerDay = Math.ceil(businessChecks + offHourChecks);
    }

    // 1回あたりの上限で調整（新着10件まで）
    const maxRunsPerDay = Math.max(1, Math.floor(params.maxItemsPerRun > 0
      ? checksPerDay / params.maxItemsPerRun
      : checksPerDay));

    // AI分析は変化があった時だけ
    const aiCallsPerDay = Math.max(1, Math.round(checksPerDay * tier.changeRate));

    // AI分析1回あたりコスト
    const aiCost = aiCallsPerDay * tier.aiCostPerCall;
    // チェックコスト（AI分析とは別）
    const checkCost = checksPerDay * params.baselineCostPerCheck;

    totalChecksPerDay += checksPerDay;
    totalAiCallsPerDay += aiCallsPerDay;
    totalCost += checkCost + aiCost;

    tierDetails.push({
      tier: tier.label,
      checksPerDay,
      aiCallsPerDay,
      checkCost: Math.round(checkCost * 1000000) / 1000000,
      aiCost: Math.round(aiCost * 1000000) / 1000000,
      totalCost: Math.round((checkCost + aiCost) * 1000000) / 1000000,
    });
  }

  return {
    cost: Math.round(totalCost * 1000000) / 1000000,
    checksPerDay: totalChecksPerDay,
    aiCallsPerDay: totalAiCallsPerDay,
    details: tierDetails,
  };
}

/**
 * 削減率を計算
 * @param {number} baseline
 * @param {number} improved
 * @returns {number} 0.0-1.0の削減率（1.0 = 100%削減）
 */
function savingsRate(baseline, improved) {
  if (baseline <= 0) return 0;
  return Math.round((1 - improved / baseline) * 10000) / 10000;
}

/**
 * 全シナリオの結果を計算
 * @param {object} params
 * @returns {object[]}
 */
function calculateAll(params = DEFAULT_PARAMS) {
  return SCENARIOS.map((scenario) => {
    const baseline = baselineDailyCost(scenario);
    const improved = improvedDailyCost(scenario, params);
    const savings = savingsRate(baseline, improved.cost);
    const checkReduction = savingsRate(scenario.baselineChecksPerDay, improved.checksPerDay);
    const aiReduction = savingsRate(scenario.baselineAiCallsPerDay, improved.aiCallsPerDay);

    return {
      label: scenario.label,
      description: scenario.description,
      baseline: {
        checksPerDay: scenario.baselineChecksPerDay,
        aiCallsPerDay: scenario.baselineAiCallsPerDay,
        dailyCost: Math.round(baseline * 1000000) / 1000000,
      },
      improved: {
        checksPerDay: improved.checksPerDay,
        aiCallsPerDay: improved.aiCallsPerDay,
        dailyCost: improved.cost,
        tierDetails: improved.details,
      },
      savings: {
        checkReductionPct: Math.round(checkReduction * 10000) / 100,
        aiReductionPct: Math.round(aiReduction * 10000) / 100,
        totalSavingsPct: Math.round(savings * 10000) / 100,
      },
    };
  });
}

// === 表示関数 ===

/**
 * 結果をテキスト表示
 * @param {object[]} results
 */
function printResults(results) {
  console.log('Grok監視頻度最適化 コスト削減モデル');
  console.log('=' .repeat(60));
  console.log('改善前基準: 1分間隔 × 全対象 = 1日1,440回チェック + AI分析毎回');
  console.log('');

  for (const r of results) {
    console.log(`【${r.label}】${r.description}`);
    console.log(`  ├─ 改善前: ${r.baseline.checksPerDay}回/日 チェック, ${r.baseline.aiCallsPerDay}回/日 AI分析, $${r.baseline.dailyCost}/日`);
    console.log(`  ├─ 改善後: ${r.improved.checksPerDay}回/日 チェック, ${r.improved.aiCallsPerDay}回/日 AI分析, $${r.improved.dailyCost}/日`);
    console.log(`  ├─ チェック削減: ${r.savings.checkReductionPct}%`);
    console.log(`  ├─ AI分析削減: ${r.savings.aiReductionPct}%`);
    console.log(`  └─ 総コスト削減: ${r.savings.totalSavingsPct}%`);
    console.log('');
  }
}

/**
 * 結果をJSON表示
 * @param {object[]} results
 */
function printResultsJson(results) {
  console.log(JSON.stringify(results, null, 2));
}

// === CLI エントリ ===

function parseArgs() {
  const args = process.argv.slice(2);
  const scenario = args.findIndex((a) => a === '--scenario') >= 0
    ? args[args.findIndex((a) => a === '--scenario') + 1] : null;
  const asJson = args.includes('--json');
  const list = args.includes('--list');
  return { scenario, asJson, list };
}

function main() {
  const { scenario, asJson, list } = parseArgs();

  if (list) {
    console.log('利用可能なシナリオ:');
    for (const s of SCENARIOS) {
      console.log(`  ${s.label}: ${s.description}`);
    }
    return;
  }

  const results = calculateAll();

  if (scenario) {
    const filtered = results.filter((r) => r.label === scenario);
    if (filtered.length === 0) {
      console.error(`シナリオ '${scenario}' が見つかりません`);
      process.exit(1);
    }
    if (asJson) {
      printResultsJson(filtered);
    } else {
      printResults(filtered);
    }
    return;
  }

  if (asJson) {
    printResultsJson(results);
  } else {
    printResults(results);
  }
}

main();