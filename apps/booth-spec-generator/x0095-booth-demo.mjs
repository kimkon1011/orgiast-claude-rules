// apps/booth-spec-generator/x0095-booth-demo.mjs — X-0095 ブース制作コスト比較デモ
// 展示会ブースの類似デザイン生成を題材に、キャッシュ＋ルーティングのコスト削減効果を測定。
// 3モード比較:
//   1. RAW: 常に高額モデル (openai/gpt-4o) を使う
//   2. CACHE: 同一リクエストをキャッシュ
//   3. ROUTE: 複雑度に応じてモデル振り分け + キャッシュ
//
// 使い方:
//   node apps/booth-spec-generator/x0095-booth-demo.mjs [--iterations N] [--compact]
//
// オプション:
//   --iterations N  生成するデザイン案の数 (既定: 全バリアント)
//   --compact       コンパクト表示

import { processRequest, runBenchmark, classifyComplexity, selectModel, estimateCost, computePipelineStats, checkBudget } from '../../tools/x0095-cache-router.mjs';
import { initStorage } from '../../tools/x0095-cache-router.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../../tools/is-entry.mjs';

// ───────── ブースデザイン要求シナリオ ─────────

const BOOTH_DESIGN_REQUESTS = [
  {
    title: '新製品展示（ハイテク）',
    prompt: `展示会ブースデザインを提案。
条件:
- ブースサイズ: 標準小間 (2.7m × 6m)
- 予算: 180万円
- 展示品: 新製品 A (卓上サイズ) を4台
- 商談スペース: 1卓 + 椅子3脚
- 壁面: 背面のみ白パネル、左右はオープン
- 必須: 製品を手に取って試せるデモカウンター`,
    variant: 'custom'
  },
  {
    title: 'ブランド訴求ブース',
    prompt: `ブランドイメージを強調するブースデザイン。
条件:
- ブースサイズ: 6m × 6m コーナー
- 予算: 350万円
- 目的: 新ブランドの市場投入を告知
- 必須: 大型ビジョン (50型以上) 2台、バックライトパネル
- 商談スペース: 2卓 (半個室)`,
    variant: 'custom'
  },
  {
    title: '商談特化ブース',
    prompt: `商談を最優先したブースレイアウト。
条件:
- ブースサイズ: 3m × 3m
- 予算: 120万円
- 商談卓: 2卓 (パーテーションで区切れる)
- 内装: クローズド個室
- 壁面: 全周ホワイトパネル
- 必要設備: Wi-Fi、電源タップ4口`,
    variant: 'custom'
  },
  {
    title: '簡易レイアウト提案（分類依頼）',
    prompt: '分類: 以下の条件のブースはA・B・Cのどのタイプに該当するか。予算200万、製品数5、商談重視、3m×3m',
    variant: 'classification'
  },
  {
    title: '出展申込書チェック（定型作業）',
    prompt: '定型: 展示会出展申込書の記入必須項目をチェックリスト化。小間サイズ・電源・備品レンタル・搬入時間・人員配置',
    variant: 'template'
  },
  {
    title: 'デモ重視ブース（技術展示）',
    prompt: `ハイテク製品のデモを中心に据えたブース。
条件:
- ブースサイズ: 6m × 9m 島型
- 予算: 500万円
- デモエリア: 体験コーナー 4台 (タブレット+実際の製品)
- プレゼンエリア: 20席のミニシアター
- 壁面: 全面オープン、ブランドカラー差し色
- 備品: 大型LED 1台、カウンター2台、バーカウンター`,
    variant: 'custom'
  },
  {
    title: '見積比較分析',
    prompt: '分析: 3社の見積書を比較。A社 450万円、B社 520万円、C社 380万円。各社の内訳から価格差の理由を特定し、適正在格をレポート。',
    variant: 'analysis'
  },
  {
    title: '施工手順の抽出',
    prompt: '抽出: 以下の施工計画書から、設営に必要な作業項目・所要時間・人員数・注意事項を表形式で抽出。計画書: 3日間設営、6名、電源工事あり、吊り天井3点、パネル12枚、床貼りあり。',
    variant: 'classification'
  },
];

// ───────── モード定義 ─────────

const MODE_RATES = {
  RAW:       { model: 'openai/gpt-4o',      inputPerM: 2.50, outputPerM: 10.00 },
  CACHE:     { model: 'openai/gpt-4o',      inputPerM: 2.50, outputPerM: 10.00 },  // キャッシュ時は0
  ROUTE:     null,  // classifyComplexity で動的選択
};

function getRoutedModel(classification) {
  const sel = selectModel(classification);
  return sel.model;
}

// ───────── コストシミュレーション ─────────

function simulateRequest(prompt, mode, inputTokens, outputTokens) {
  if (mode === 'ROUTE') {
    const classification = classifyComplexity(prompt);
    const model = getRoutedModel(classification);
    return {
      model,
      complexity: classification.level,
      cost: estimateCost(inputTokens, outputTokens, model),
      tokens: { input: inputTokens, output: outputTokens },
    };
  }
  // RAW or CACHE
  const rate = MODE_RATES[mode];
  const cost = (inputTokens / 1e6) * rate.inputPerM + (outputTokens / 1e6) * rate.outputPerM;
  return {
    model: rate.model,
    complexity: 'all',
    cost,
    tokens: { input: inputTokens, output: outputTokens },
  };
}

// ───────── メイン ─────────

async function main() {
  const args = process.argv.slice(2);
  const compact = args.includes('--compact');
  const iterIdx = args.indexOf('--iterations');
  const iterations = iterIdx >= 0 && iterIdx + 1 < args.length ? parseInt(args[iterIdx + 1], 10) || 0 : 0;

  initStorage();

  const requests = iterations > 0 ? BOOTH_DESIGN_REQUESTS.slice(0, iterations) : BOOTH_DESIGN_REQUESTS;

  console.log('=== X-0095 ブース制作コスト比較デモ ===\n');
  console.log(`デザイン要求数: ${requests.length}\n`);

  // 各モードのコスト計算
  const modes = ['RAW', 'CACHE', 'ROUTE'];
  const results = {};

  for (const mode of modes) {
    let totalCost = 0;
    let isFirstInCache = true;
    const seen = new Set();
    const details = [];

    for (const req of requests) {
      const inputTokens = Math.ceil(req.prompt.length / 4) + 150;
      const outputTokens = req.prompt.length > 1000 ? 600 : 400;
      const promptKey = req.prompt.slice(0, 100);

      // CACHE モード: 同一プロンプトは2回目以降 cost=0
      if (mode === 'CACHE') {
        if (seen.has(promptKey)) {
          details.push({ title: req.title, cost: 0, inputTokens: 0, outputTokens: 0 });
          continue;
        }
        seen.add(promptKey);
      }

      const sim = simulateRequest(req.prompt, mode, inputTokens, outputTokens);
      totalCost += sim.cost;
      details.push({ title: req.title, cost: sim.cost, model: sim.model, complexity: sim.complexity, inputTokens, outputTokens });
    }

    results[mode] = { totalCost: Math.round(totalCost * 1000) / 1000, details };
  }

  // RAW コストを基準に比較
  const rawTotal = results['RAW'].totalCost;
  const cacheTotal = results['CACHE'].totalCost;
  const routeTotal = results['ROUTE'].totalCost;
  const cacheSavings = Math.round((rawTotal - cacheTotal) * 1000) / 1000;
  const routeSavings = Math.round((rawTotal - routeTotal) * 1000) / 1000;
  const cacheSavingsPct = rawTotal > 0 ? Math.round((cacheSavings / rawTotal) * 1000) / 10 : 0;
  const routeSavingsPct = rawTotal > 0 ? Math.round((routeSavings / rawTotal) * 1000) / 10 : 0;

  if (!compact) {
    // 詳細表示
    console.log('各デザイン要求の詳細:\n');
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      const raw = results['RAW'].details[i];
      const cache = results['CACHE'].details[i];
      const route = results['ROUTE'].details[i];
      console.log(`[${i + 1}] ${req.title}`);
      console.log(`    入力: ${raw.inputTokens}tok / 出力: ${raw.outputTokens}tok`);
      if (raw.complexity) console.log(`    複雑度(ROUTE時): ${route.complexity} → ${route.model}`);
      console.log(`    RAW:   $${raw.cost.toFixed(6)}`);
      console.log(`    CACHE: $${cache.cost.toFixed(6)}`);
      console.log(`    ROUTE: $${route.cost.toFixed(6)}`);
      console.log();
    }
  }

  // サマリ
  console.log('=== コスト比較サマリ ===');
  console.log(`モード              総コスト(USD)  削減額   削減率`);
  console.log(`───              ───────────   ────   ────`);
  console.log(`RAW (gpt-4o常時)    $${String(rawTotal).padStart(8)}    —        —`);
  console.log(`CACHE (重複除去)    $${String(cacheTotal).padStart(8)}    $${String(cacheSavings).padStart(6)}  ${String(cacheSavingsPct).padStart(5)}%`);
  console.log(`ROUTE (振分+キャッシュ) $${String(routeTotal).padStart(8)}    $${String(routeSavings).padStart(6)}  ${String(routeSavingsPct).padStart(5)}%`);

  // ROUTE の複雑度別内訳
  const routeDetails = results['ROUTE'].details;
  const byComplexity = {};
  for (const d of routeDetails) {
    if (d.cost === undefined) continue;
    const c = d.complexity || 'all';
    if (!byComplexity[c]) byComplexity[c] = { count: 0, cost: 0, model: d.model || '' };
    byComplexity[c].count++;
    byComplexity[c].cost += d.cost;
  }

  console.log('\n=== ルーティング内訳（ROUTEモード）===');
  for (const [level, data] of Object.entries(byComplexity)) {
    const avgCost = data.count > 0 ? Math.round((data.cost / data.count) * 1e6) / 1e6 : 0;
    console.log(`  ${level.padStart(10)}: ${String(data.count).padStart(2)}件  合計$${String(Math.round(data.cost * 1000) / 1000).padStart(8)}  平均$${avgCost}`);
  }

  // ベンチマークも実行
  console.log('\n=== パイプライン処理ベンチマーク ===');
  const benchResults = await runBenchmark({ scenario: 'booth-proposal', iterations: Math.min(5, requests.length) });
  console.log(`  リクエスト数: ${benchResults.totalRequests}`);
  console.log(`  キャッシュヒット: ${benchResults.cacheHits}`);
  console.log(`  RAWコスト: $${benchResults.totalRawCostUsd}`);
  console.log(`  ルーティング後コスト: $${benchResults.totalRoutedCostUsd}`);
  console.log(`  削減率: ${benchResults.savingsPercent}%`);

  // 予算状態
  const budget = checkBudget();
  console.log(`\n=== 予算状態 ===`);
  console.log(`  当月支出: $${budget.spentUsd} / 月次予算 $${budget.monthlyBudgetUsd}`);
  console.log(`  使用率: ${budget.usedRatio}%`);

  console.log('\n✅ デモ完了');
}

if (isEntry(import.meta.url)) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}