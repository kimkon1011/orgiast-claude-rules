#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DEFAULT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ASTRA_EFFICIENCY_FACTOR = 0.31;

// トークン量は百万トークン単位。cachedRatio は各入力区分の内数。
export const SCENARIOS = [
  { id: 'nightly-batch', label: '夜間バッチ分類・整形', tier: 'batch', eligibleTiers: ['batch'], shortInput: 300, shortCachedRatio: 0, longInput: 0, longCachedRatio: 0, shortOutput: 30, longOutput: 0 },
  { id: 'coding-agent', label: '実装エージェント', tier: 'standard', eligibleTiers: ['standard'], shortInput: 120, shortCachedRatio: 0.6, longInput: 80, longCachedRatio: 0.6, shortOutput: 40, longOutput: 0 },
  { id: 'chat-assistant', label: '定常チャット', tier: 'standard', eligibleTiers: ['standard'], shortInput: 200, shortCachedRatio: 0.85, longInput: 0, longCachedRatio: 0, shortOutput: 20, longOutput: 0 },
  { id: 'doc-summarize', label: '長文ドキュメント要約', tier: 'flex', eligibleTiers: ['flex'], shortInput: 0, shortCachedRatio: 0, longInput: 500, longCachedRatio: 0, shortOutput: 0, longOutput: 50 },
  { id: 'realtime-quick', label: '即時短命応答', tier: 'standard', eligibleTiers: ['standard'], shortInput: 50, shortCachedRatio: 0.3, longInput: 0, longCachedRatio: 0, shortOutput: 5, longOutput: 0 },
];

const finiteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const usd = (value) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function calculateCost(scenario, prices, tokenFactor = 1) {
  if (!finiteNonNegative(tokenFactor)) throw new Error('tokenFactor は0以上の数が必要です');
  const fields = ['shortInput', 'shortCachedRatio', 'longInput', 'longCachedRatio', 'shortOutput', 'longOutput'];
  if (fields.some((field) => !finiteNonNegative(scenario[field]))) throw new Error(`シナリオのトークン量または比率が不正です: ${scenario.id ?? 'unknown'}`);
  if (scenario.shortCachedRatio > 1 || scenario.longCachedRatio > 1) throw new Error('cachedRatio は0以上1以下が必要です');
  const shortCached = scenario.shortInput * scenario.shortCachedRatio;
  const longCached = scenario.longInput * scenario.longCachedRatio;
  return tokenFactor * (
    (scenario.shortInput - shortCached) * prices.shortInput
    + shortCached * prices.shortCached
    + (scenario.longInput - longCached) * prices.longInput
    + longCached * prices.longCached
    + scenario.shortOutput * prices.shortOutput
    + scenario.longOutput * prices.longOutput
  );
}

export function breakEvenAnalysis(priceRatio, astraConsumptionRatio = ASTRA_EFFICIENCY_FACTOR) {
  if (!(priceRatio > 0) || !Number.isFinite(priceRatio)) throw new Error('priceRatio は正の数が必要です');
  const threshold = 1 / priceRatio;
  return {
    priceRatio,
    threshold,
    astraConsumptionRatio,
    astraWins: astraConsumptionRatio < threshold,
    equalCostAtThreshold: astraConsumptionRatio === threshold,
  };
}

export function analyzeScenario(scenario, catalog) {
  const modelIds = ['gpt-6-astra', 'gpt-5.6-sol'];
  const costs = Object.fromEntries(modelIds.map((modelId) => {
    const tiers = scenario.eligibleTiers.map((tier) => ({ tier, costUsd: calculateCost(scenario, catalog.models[modelId].tiers[tier]) }));
    tiers.sort((a, b) => a.costUsd - b.costUsd || a.tier.localeCompare(b.tier));
    return [modelId, { ...tiers[0], eligibleTiers: [...scenario.eligibleTiers] }];
  }));
  const astra = costs['gpt-6-astra'].costUsd;
  const sol = costs['gpt-5.6-sol'].costUsd;
  const adjustedAstra = astra * ASTRA_EFFICIENCY_FACTOR;
  return {
    id: scenario.id,
    label: scenario.label,
    requiredTier: scenario.tier,
    costs,
    winner: astra < sol ? 'gpt-6-astra' : astra > sol ? 'gpt-5.6-sol' : 'tie',
    ratio: astra / sol,
    efficiencyReference: {
      status: catalog.facts.astraTokenEfficiencyClaim.status,
      tokenFactor: ASTRA_EFFICIENCY_FACTOR,
      astraCostUsd: adjustedAstra,
      versusSolRatio: adjustedAstra / sol,
      winner: adjustedAstra < sol ? 'gpt-6-astra' : adjustedAstra > sol ? 'gpt-5.6-sol' : 'tie',
    },
  };
}

export function calculatePlan(catalog, scenarios = SCENARIOS) {
  const breakEven = breakEvenAnalysis(catalog.facts.priceRatioAstraOverSol);
  return {
    priceAsOf: catalog.priceAsOf,
    source: catalog.sources.pricing,
    breakEven,
    scenarios: scenarios.map((scenario) => analyzeScenario(scenario, catalog)),
    verification: {
      pricing: 'verified-primary',
      astraTokenEfficiencyClaim: catalog.facts.astraTokenEfficiencyClaim.status,
    },
  };
}

export function formatReport(result, catalog) {
  const claim = catalog.facts.astraTokenEfficiencyClaim;
  const lines = [
    '# GPT-6 Astra / GPT-5.6 Sol コスト比較', '',
    `> 価格は ${catalog.priceAsOf} 時点。一次出典: ${catalog.sources.pricing}。GPT-5.6 Sol はプロモ価格（〜${catalog.facts.solPromotionalPricingThrough}）。`,
    '> このファイルは生成物。手で編集しない。再生成: `node tools/astra-sol-cost-plan.mjs`', '',
    '## 結論', '',
    '**同じトークン量なら、全5シナリオで GPT-5.6 Sol が最安。** Astra は全カテゴリで Sol の2.5倍なので、価格だけで選ぶ最適プランは各シナリオの許容ティア × Sol。', '',
    '| シナリオ | 許容最安ティア | Astra/月 | Sol/月 | Astra/Sol | price-only winner |',
    '|---|---:|---:|---:|---:|---|',
    ...result.scenarios.map((item) => `| ${item.id} | ${item.costs['gpt-5.6-sol'].tier} | ${usd(item.costs['gpt-6-astra'].costUsd)} | ${usd(item.costs['gpt-5.6-sol'].costUsd)} | ${item.ratio.toFixed(2)}x | ${item.winner} |`), '',
    '## シナリオ別判定', '',
    ...result.scenarios.flatMap((item) => [
      `### ${item.id} — ${item.label}`, '',
      `- 最適プラン: **GPT-5.6 Sol × ${item.costs['gpt-5.6-sol'].tier}**（${usd(item.costs['gpt-5.6-sol'].costUsd)}/月）`,
      `- Astra: ${usd(item.costs['gpt-6-astra'].costUsd)}/月、Sol比 ${item.ratio.toFixed(2)}x。`,
      `- 69%削減仮定のAstra参考値: ${usd(item.efficiencyReference.astraCostUsd)}/月、Sol比 ${item.efficiencyReference.versusSolRatio.toFixed(3)}x — **${item.efficiencyReference.status}**。`, '',
    ]),
    '## ブレークイーブン', '',
    `価格比 ${result.breakEven.priceRatio}x では、Astraの消費トークンが Sol の **${(result.breakEven.threshold * 100).toFixed(0)}%未満**ならAstraが安い（40%ちょうどは同額）。`,
    `二次報道の「69%減」を仮定すると消費量は31%で、価格比込みの費用はSol比 ${(result.breakEven.priceRatio * ASTRA_EFFICIENCY_FACTOR).toFixed(3)}x。ただし、この効率主張は **${claim.status}** であり、購入判断の確定値には使わない。`, '',
    '## ティア制約と注記', '',
    '- batch: 夜間バッチなど遅延を許容できる処理だけに使用。',
    '- flex: 遅延・中断を許容できる処理だけに使用。',
    '- standard: 即時性や安定した実行を要する残りのシナリオに使用。',
    '- fast: standard の2倍。最安比較から除外。',
    `- リージョナル処理は ${catalog.facts.regionalUpliftPct}% 上乗せ。本表には未加算。`,
    '- cache writes 単価はカタログに保持するが、今回の5シナリオでは使用しない。', '',
    '## 検証状況', '',
    `- 価格・ティア: **verified-primary** — ${catalog.sources.pricing}`,
    `- 69%トークン効率: **${claim.status}** — ${claim.source}`,
    `- コンテキスト窓: **${catalog.facts.contextWindowTokens.status}**（本計算には不使用）`, '',
    '## 出典', '',
    `- ${catalog.sources.pricing}`, '',
  ];
  return lines.join('\n');
}

export function runPlan(options = {}) {
  const repo = options.repo || DEFAULT_REPO;
  const catalogPath = options.catalogPath || path.join(repo, 'tools', 'astra-sol-cost-catalog.json');
  const docPath = options.docPath || path.join(repo, 'docs', 'astra-sol-cost-plan.md');
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const result = calculatePlan(catalog);
    const markdown = `${formatReport(result, catalog)}\n`;
    if (options.check) {
      const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8').replace(/\r\n/gu, '\n') : null;
      if (current !== markdown) throw new Error('drift: docs/astra-sol-cost-plan.md が古い。node tools/astra-sol-cost-plan.mjs で再生成');
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      fs.writeFileSync(docPath, markdown.replace(/\r\n/gu, '\n'), 'utf8');
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

function parseCli(args) {
  const allowed = new Set(['--json', '--check']);
  for (const item of args) if (!allowed.has(item)) throw new Error(`不正な引数です: ${item}`);
  if (args.includes('--json') && args.includes('--check')) throw new Error('--json と --check は同時指定できません');
  return { json: args.includes('--json'), check: args.includes('--check') };
}

if (isEntry(import.meta.url)) {
  try {
    process.exitCode = runPlan(parseCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`使用法: node tools/astra-sol-cost-plan.mjs [--json|--check]\n${error.message}\n`);
    process.exitCode = 1;
  }
}
