#!/usr/bin/env node
// X-0026 ブースデザイン生成ベンチマークランナー
// 既存の model-router.mjs を活用し、25件のベンチマークプロンプトを分類・コスト計算する。
// --mock モード: 模擬品質スコア付き。API呼び出しなし。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTING_TABLE, validateModel, classifyTask } from './model-router.mjs';
import { isEntry } from './is-entry.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_FILE = path.join(DIR, '..', 'outputs', 'X-0026', 'booth-design-benchmark.jsonl');

// ブースデザイン固有の simple 判定オーバーレイ。
// 既存 model-router.mjs の RULES はタイトル/キャッチコピー生成のキーワードを持たず
// unknown→medium に落とすため、ブース業務で明らかに simple なタスクを拾う。
// model-router 側への RULES 拡張（タイトル|キャッチコピー等を simple に追加）は PHASE2。
const BOOTH_SIMPLE = /タイトル|キャッチコピー|見出し|タグライン|スローガン/;

export function classifyPrompt(text) {
  const route = classifyTask(text);
  if (route !== 'unknown') return route;
  if (BOOTH_SIMPLE.test(text)) return 'simple';
  return 'medium';
}

export function estimateTokens(prompt) {
  // 簡易トークン見積: 日本語は文字数×0.75、英数字は単語数×1.3
  const jp = (prompt.match(/[　-鿿＀-￯]/g) || []).length;
  const en = prompt.replace(/[　-鿿＀-￯\s]/g, '').length;
  return Math.ceil(jp * 0.75 + en * 0.3);
}

export function estimateOutputTokens(route) {
  if (route === 'simple') return 30;
  if (route === 'medium') return 120;
  return 300;
}

export function costPerRoute(route, inputTokens, outputTokens) {
  const table = ROUTING_TABLE[route];
  if (!table) return 0;
  return (inputTokens / 1_000_000) * table.inputPerMillion
    + (outputTokens / 1_000_000) * table.outputPerMillion;
}

export function qualityScore(route, expectedRoute) {
  // 模擬品質スコア: 期待ルートのモデルは高め、他は低め（@rohanpaul_ai の損失0.44点を参考）
  const base = { simple: 4.0, medium: 4.3, complex: 4.8 };
  const penalty = route === expectedRoute ? 0 : 0.5;
  const score = (base[route] || 4.0) - penalty;
  return Math.max(1, Math.min(5, Math.round(score * 10) / 10));
}

export function loadBenchmarks(benchmarkPath = BENCHMARK_FILE) {
  const text = fs.readFileSync(benchmarkPath, 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function runBenchmark({ mock = false, benchmarks = null, provider = 'openrouter' } = {}) {
  if (provider !== 'openrouter') throw new Error('Only openrouter is supported; anthropic is prohibited');
  const items = benchmarks || loadBenchmarks();
  const rows = items.map(item => {
    const detectedRoute = classifyPrompt(item.prompt);
    const inputTokens = estimateTokens(item.prompt);
    const outputTokens = estimateOutputTokens(detectedRoute);
    const route = ROUTING_TABLE[detectedRoute];
    const cost = costPerRoute(detectedRoute, inputTokens, outputTokens);
    const quality = mock ? qualityScore(detectedRoute, item.expectedRoute) : null;
    return {
      id: item.id,
      category: item.category,
      expectedRoute: item.expectedRoute,
      detectedRoute,
      routeMatch: detectedRoute === item.expectedRoute,
      inputTokens,
      outputTokens,
      costUsd: cost,
      model: route?.model || 'unknown',
      quality: quality,
    };
  });
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const matched = rows.filter(r => r.routeMatch).length;
  const avgQuality = mock ? rows.reduce((s, r) => s + (r.quality || 0), 0) / rows.length : null;
  return { rows, summary: { total: rows.length, matched, totalCostUsd: totalCost, avgQuality } };
}

export function renderReport(result) {
  const { rows, summary } = result;
  const baselineCost = rows.reduce((s, r) => {
    const complexRoute = 'complex';
    const baseCost = costPerRoute(complexRoute, r.inputTokens, 300);
    return s + baseCost;
  }, 0);
  const savingPct = baselineCost > 0 ? ((baselineCost - summary.totalCostUsd) / baselineCost * 100).toFixed(1) : 0;
  let report = `# Booth Design Benchmark Report

## Summary
- **Benchmarks**: ${summary.total}
- **Route match**: ${summary.matched}/${summary.total} (${(summary.matched / summary.total * 100).toFixed(0)}%)
- **Total cost (routing)**: $${summary.totalCostUsd.toFixed(6)}
- **Baseline cost (all complex)**: $${baselineCost.toFixed(6)}
- **Saving**: ${savingPct}%
`;
  if (summary.avgQuality !== null) {
    report += `- **Avg quality score (mock)**: ${summary.avgQuality.toFixed(2)}/5\n`;
  }
  report += `\n## Per-prompt results\n\n`;
  report += `| ID | Category | Expected | Detected | Match | Input Tokens | Output Tokens | Model | Cost |`;
  if (summary.avgQuality !== null) report += ` Quality |`;
  report += `\n|---:|:---|---:|---:|:---|---:|---:|:---|:---|`;
  if (summary.avgQuality !== null) report += `:---|`;
  report += `\n`;
  for (const r of rows) {
    report += `| ${r.id} | ${r.category} | ${r.expectedRoute} | ${r.detectedRoute} | ${r.routeMatch ? '✅' : '❌'} | ${r.inputTokens} | ${r.outputTokens} | ${r.model} | $${r.costUsd.toFixed(6)} |`;
    if (summary.avgQuality !== null) report += ` ${r.quality !== null ? r.quality.toFixed(1) : '-'} |`;
    report += `\n`;
  }
  return report;
}

export function main(args = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mock') opts.mock = true;
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--provider') opts.provider = args[++i];
    else if (args[i] === '--benchmark') opts.benchmarkPath = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: booth-bench.mjs [options]

Options:
  --mock              模擬モード（品質スコア表示、API呼び出しなし）
  --out <file>        結果をファイルに出力
  --provider <name>   プロバイダ（openrouterのみ対応）
  --benchmark <file>  ベンチマークファイル（既定: outputs/X-0026/booth-design-benchmark.jsonl）
  --help, -h          このヘルプ`);
      return;
    }
  }
  const benchmarks = opts.benchmarkPath ? loadBenchmarks(opts.benchmarkPath) : null;
  const result = runBenchmark({ mock: opts.mock, benchmarks, provider: opts.provider });
  const report = renderReport(result);
  if (opts.out) fs.writeFileSync(opts.out, report);
  console.log(report);
}

if (isEntry(import.meta.url)) {
  main(process.argv.slice(2));
}
