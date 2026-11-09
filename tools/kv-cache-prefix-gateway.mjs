#!/usr/bin/env node
// KV-cache prefix sharing gateway — group requests by shared system prompt prefix,
// measure TTFT, and report cache efficiency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const CACHE_STORE_DIR = path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'kv-cache-gateway');

// ---------- Cache state ----------

export function cacheStorePath() {
  return path.join(CACHE_STORE_DIR, 'state.json');
}

function ensureStoreDir() {
  fs.mkdirSync(CACHE_STORE_DIR, { recursive: true });
}

export function readCacheState() {
  try {
    return JSON.parse(fs.readFileSync(cacheStorePath(), 'utf8'));
  } catch {
    return {};
  }
}

export function writeCacheState(state) {
  ensureStoreDir();
  fs.writeFileSync(cacheStorePath(), JSON.stringify(state, null, 2) + '\n');
}

// ---------- Prefix extraction ----------

/**
 * Extract common system prompt text from an array of LLM request payloads.
 * Returns the longest shared prefix that is at least `minChars` long.
 */
export function extractCommonPrefix(requests, { minChars = 20 } = {}) {
  if (!requests || requests.length === 0) return { prefix: '', common: true };
  // 各リクエストからシステムプロンプトを取得
  const prompts = requests.map((req) => {
    if (typeof req === 'string') return req;
    if (req.system) return req.system;
    if (Array.isArray(req.messages)) {
      const sysMsg = req.messages.find((m) => m.role === 'system');
      return sysMsg ? sysMsg.content : '';
    }
    return '';
  });
  // 共通プレフィックスを計算
  let prefix = prompts[0];
  for (let i = 1; i < prompts.length; i++) {
    let j = 0;
    while (j < prefix.length && j < prompts[i].length && prefix[j] === prompts[i][j]) j++;
    prefix = prefix.slice(0, j);
    if (j < minChars) break;
  }
  return { prefix, common: prefix.length >= minChars };
}

/**
 * Estimate token count for a text (rough: ~4 chars per token).
 */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// ---------- TTFT measurement ----------

/**
 * Measure per-request TTFT and total duration from an array of results.
 * Each result: { request, startedAt, firstTokenAt?, completedAt?, ... }
 * Returns { ttftMs, totalMs, avgTtftMs, ttftReduction }.
 */
export function measureTTFT(results) {
  if (!results || results.length === 0) return {};
  const ttfts = results
    .filter((r) => r.firstTokenAt != null && r.startedAt != null)
    .map((r) => r.firstTokenAt - r.startedAt);
  const avgTtftMs = ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0;
  const firstMs = ttfts[0] || 0;
  const lastMs = ttfts[ttfts.length - 1] || 0;
  const ttftReduction = firstMs > 0 ? (1 - lastMs / firstMs) * 100 : 0;
  return {
    ttftArray: ttfts,
    avgTtftMs: Math.round(avgTtftMs),
    ttftReduction: Math.round(ttftReduction * 10) / 10,
    firstTtftMs: Math.round(firstMs),
    lastTtftMs: Math.round(lastMs),
    requestCount: results.length,
  };
}

// ---------- Cache statistics ----------

/**
 * Simulate cache cost savings based on token counts.
 * OpenRouter charges less for cached input tokens (typically ~10% of uncached).
 */
export function reportCacheEfficiency(results, { promptCostPerM = 0.15, cachedCostPerM = 0.015, prefixTokens = 0 } = {}) {
  const report = { requests: 0, totalTokens: 0, cachedTokens: 0, uncachedTokens: 0, costUncached: 0, costCached: 0, savingsPercent: 0, cachedHitRate: 0 };
  if (!results || results.length === 0) return report;
  let totalSuffixTokens = 0;
  let totalPrefixTokens = 0;
  for (const r of results) {
    const tokens = r.inputTokens || r.usage?.input_tokens || r.usage?.prompt_tokens || estimateTokens(r.prompt || '');
    report.totalTokens += tokens;
    const prefix = prefixTokens > 0 ? prefixTokens : Math.round(tokens * 0.7);
    const suffix = tokens - prefix;
    totalPrefixTokens += prefix;
    totalSuffixTokens += suffix;
  }
  // キャッシュ無し: 全トークンが定額
  report.costUncached = (report.totalTokens / 1e6) * promptCostPerM;
  // キャッシュ有り: 初回の全トークンは定額、2回目以降のプレフィックスは割引
  const firstRequest = results.find((r) => r.isFirst);
  const firstTokens = firstRequest
    ? (firstRequest.inputTokens || firstRequest.usage?.input_tokens || firstRequest.usage?.prompt_tokens || estimateTokens(firstRequest.prompt || ''))
    : 0;
  const firstPrefixTokens = prefixTokens > 0 ? prefixTokens : Math.round(firstTokens * 0.7);
  const cachedPrefixTokens = totalPrefixTokens - firstPrefixTokens;
  const uncachedPrefixTokens = totalPrefixTokens - cachedPrefixTokens;
  report.uncachedTokens = uncachedPrefixTokens + totalSuffixTokens;
  report.cachedTokens = cachedPrefixTokens;
  report.costCached = (report.uncachedTokens / 1e6) * promptCostPerM + (cachedPrefixTokens / 1e6) * cachedCostPerM;
  report.savingsPercent = report.costUncached > 0
    ? Math.round((1 - report.costCached / report.costUncached) * 1000) / 10
    : 0;
  report.requests = results.length;
  report.cachedHitRate = results.length > 1
    ? Math.round(((results.length - 1) / results.length) * 1000) / 10
    : 0;
  return report;
}

/**
 * Run a demo scenario showing KV-cache prefix sharing.
 * Generates synthetic timing data to demonstrate expected savings.
 */
export function demo(scenario = 'booth-proposal') {
  const scenarios = {
    'booth-proposal': {
      title: '展示会ブース提案生成（3案件）',
      requests: [
        { id: 'case-A', promptPrefixChars: 1200, promptSuffixChars: 200, simulatedTtftMs: 3200 },
        { id: 'case-B', promptPrefixChars: 1200, promptSuffixChars: 350, simulatedTtftMs: 600 },
        { id: 'case-C', promptPrefixChars: 1200, promptSuffixChars: 180, simulatedTtftMs: 550 },
      ],
      prefixChars: 1200,
    },
    'multiple-projects': {
      title: '複数案件一括提案生成（5案件）',
      requests: [
        { id: 'project-1', promptPrefixChars: 2000, promptSuffixChars: 300, simulatedTtftMs: 4800 },
        { id: 'project-2', promptPrefixChars: 2000, promptSuffixChars: 250, simulatedTtftMs: 750 },
        { id: 'project-3', promptPrefixChars: 2000, promptSuffixChars: 400, simulatedTtftMs: 700 },
        { id: 'project-4', promptPrefixChars: 2000, promptSuffixChars: 150, simulatedTtftMs: 680 },
        { id: 'project-5', promptPrefixChars: 2000, promptSuffixChars: 500, simulatedTtftMs: 720 },
      ],
      prefixChars: 2000,
    },
  };
  const config = scenarios[scenario] || scenarios['booth-proposal'];
  const results = config.requests.map((r, i) => ({
    id: r.id,
    startedAt: 0,
    firstTokenAt: r.simulatedTtftMs,
    completedAt: r.simulatedTtftMs + Math.round(r.simulatedTtftMs * 1.5),
    inputTokens: Math.ceil((r.promptPrefixChars + r.promptSuffixChars) / 4),
    isFirst: i === 0,
  }));
  const ttft = measureTTFT(results);
  const efficiency = reportCacheEfficiency(results);
  const prefixTokens = Math.ceil(config.prefixChars / 4);
  const sharedPrefixSnippet = `あなたは展示会ブースのプロジェクトマネージャー兼デザイナーです。
以下のデザインガイドラインに従って提案を生成してください：
- ブースサイズは標準小間（2.7m×6m）
- 使用可能な構造材はアルミフレーム（パイプ径28mm/48mm）
- パネル高さは2.5mまで（天吊り不可）
...（${config.prefixChars}文字・約${prefixTokens}トークンの共通プレフィックス）`;

  return { scenario: config.title, prefixTokens, prefixChars: config.prefixChars, sharedPrefixSnippet, results, ttft, efficiency };
}

// ---------- CLI ----------

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const scenario = args.find((a) => a.startsWith('--scenario='))?.split('=')[1] || 'booth-proposal';
  const verbose = args.includes('--verbose');

  if (args.includes('--demo')) {
    const result = demo(scenario);
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--extract-prefix')) {
    const inputFile = path.resolve(args[args.indexOf('--extract-prefix') + 1] || '');
    const requests = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const { prefix, common } = extractCommonPrefix(requests);
    console.log(JSON.stringify({ prefix, common, prefixChars: prefix.length, prefixTokens: estimateTokens(prefix) }, null, 2));
  } else {
    // Default: print help
    console.log(`KV-Cache Prefix Sharing Gateway

使い方:
  node tools/kv-cache-prefix-gateway.mjs --demo [--scenario=booth-proposal|multiple-projects]
  node tools/kv-cache-prefix-gateway.mjs --extract-prefix <requests.json>

オプション:
  --demo              デモシナリオを実行しTTFT削減効果を表示
  --scenario=<name>   シナリオ選択（デフォルト: booth-proposal）
  --verbose           詳細出力
  --extract-prefix    リクエストJSONから共通プレフィックスを抽出
`);
  }
}