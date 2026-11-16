#!/usr/bin/env node
// tools/llm-cache-store.mjs — X-0032: リクエストキャッシング＆コストログ
// 同一/類似プロンプトに対するLLM応答をキャッシュし、トークン消費・レイテンシ・
// コストを記録して削減率を測定する。
//
// 使い方:
//   node tools/llm-cache-store.mjs --demo [--scenario booth-proposal|event-estimate] [--batch N]
//   node tools/llm-cache-store.mjs --stats [--since YYYY-MM-DD]
//   node tools/llm-cache-store.mjs --cache-stats
//   node tools/llm-cache-store.mjs --clear-cache
//   node tools/llm-cache-store.mjs --request <JSON>
//
// 環境変数:
//   LLM_CACHE_DIR              キャッシュ保存先 (既定: ~/.claude/llm-cache)
//   LLM_CACHE_TTL_MS           キャッシュTTLミリ秒 (既定: 86400000 = 24h)
//   LLM_INPUT_COST_PER_M        入力1Mトークン単価 (既定: $0.25)
//   LLM_OUTPUT_COST_PER_M       出力1Mトークン単価 (既定: $1.25)
//   LLM_CACHED_INPUT_COST_PER_M キャッシュ入力1M単価 (既定: $0.03)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

// ---------- パス（env 可変） ----------

function cacheDir() {
  return process.env.LLM_CACHE_DIR || path.join(os.homedir(), '.claude', 'llm-cache');
}
function logFile() { return path.join(cacheDir(), 'request-log.jsonl'); }
function cacheIndexFile() { return path.join(cacheDir(), 'cache-index.json'); }

const CACHE_TTL_MS = parseInt(process.env.LLM_CACHE_TTL_MS || String(86400000), 10); // 既定24h

// 単価（OpenRouter Claude Haiku 目安、env 上書き可）
const RATES = Object.freeze({
  input: parseFloat(process.env.LLM_INPUT_COST_PER_M || '0.25'),
  output: parseFloat(process.env.LLM_OUTPUT_COST_PER_M || '1.25'),
  cachedInput: parseFloat(process.env.LLM_CACHED_INPUT_COST_PER_M || '0.03'),
});

// ---------- 初期化 ----------

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* OK */ }
}

export function initStore() {
  const dir = cacheDir();
  ensureDir(dir);
  if (!fs.existsSync(logFile())) fs.writeFileSync(logFile(), '', 'utf8');
  if (!fs.existsSync(cacheIndexFile())) fs.writeFileSync(cacheIndexFile(), JSON.stringify({ version: 1, entries: {} }, null, 2), 'utf8');
}

// ---------- ハッシュ関数 ----------

/**
 * プロンプトの正規化ハッシュを計算。
 * 空白・改行を統一し、コメントを除去してからSHA-256。
 */
export function normalizePrompt(text) {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\/\/.*$/gm, '')    // 行コメント除去
    .replace(/\/\*[\s\S]*?\*\//g, '') // ブロックコメント除去
    .trim();
}

export function promptHash(text) {
  return crypto.createHash('sha256').update(normalizePrompt(text)).digest('hex');
}

/**
 * プロンプトの前方一致類似率を計算（0.0〜1.0）。
 * 単語 N-gram (N=3) のJaccard類似度ベース。
 */
export function similarity(a, b) {
  const normA = normalizePrompt(a);
  const normB = normalizePrompt(b);
  if (normA === normB) return 1.0;
  const ngram = (s, n = 3) => {
    const words = s.split(/\s+/).filter(Boolean);
    const set = new Set();
    for (let i = 0; i <= words.length - n; i++) {
      set.add(words.slice(i, i + n).join(' '));
    }
    return set;
  };
  const setA = ngram(normA);
  const setB = ngram(normB);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// ---------- キャッシュ I/O ----------

export function readCacheIndex() {
  try {
    return JSON.parse(fs.readFileSync(cacheIndexFile(), 'utf8'));
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeCacheIndex(index) {
  fs.writeFileSync(cacheIndexFile(), JSON.stringify(index, null, 2), 'utf8');
}

export function cacheEntryPath(hash) {
  return path.join(cacheDir(), `${hash}.json`);
}

/**
 * キャッシュ検索。
 * 1. 完全一致（hash）
 * 2. 類似度が threshold 以上のエントリを検索
 * returns { hit: boolean, entry?: {...}, similar?: [...] }
 */
export function lookupCache(prompt, { model = '', similarityThreshold = 0.85 } = {}) {
  const hash = promptHash(prompt);
  const index = readCacheIndex();
  const now = Date.now();

  // 完全一致
  if (index.entries[hash]) {
    const meta = index.entries[hash];
    if (!(model && meta.model && meta.model !== model)) {
      if (now - meta.cachedAt < CACHE_TTL_MS) {
        const filePath = cacheEntryPath(hash);
        if (fs.existsSync(filePath)) {
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return { hit: true, entry: { ...meta, ...data }, hash };
          } catch { /* 壊れたキャッシュ */ }
        }
      }
    }
  }

  // 期限切れエントリをクリーンアップ
  let hasExpired = false;
  for (const [h, meta] of Object.entries(index.entries)) {
    if (now - meta.cachedAt >= CACHE_TTL_MS) {
      const fp = cacheEntryPath(h);
      try { fs.unlinkSync(fp); } catch { /* ignore */ }
      delete index.entries[h];
      hasExpired = true;
    }
  }
  if (hasExpired) writeCacheIndex(index);

  // 類似検索
  const similar = [];
  for (const [existingHash, meta] of Object.entries(index.entries)) {
    if (existingHash === hash) continue;
    if (model && meta.model && meta.model !== model) continue;
    const filePath = cacheEntryPath(existingHash);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const sim = similarity(prompt, data.prompt || '');
      if (sim >= similarityThreshold) {
        similar.push({ hash: existingHash, similarity: sim, cachedAt: meta.cachedAt, ...data });
      }
    } catch { /* skip */ }
  }
  similar.sort((a, b) => b.similarity - a.similarity);

  return { hit: false, similar, hash };
}

/**
 * キャッシュに保存。
 */
export function storeCache(prompt, response, { model = '', inputTokens = 0, outputTokens = 0, latencyMs = 0 } = {}) {
  initStore();
  const hash = promptHash(prompt);
  const now = Date.now();
  const entry = {
    prompt,
    response,
    model,
    inputTokens,
    outputTokens,
    latencyMs,
    cachedAt: now,
  };
  fs.writeFileSync(cacheEntryPath(hash), JSON.stringify(entry, null, 2), 'utf8');

  const index = readCacheIndex();
  index.entries[hash] = { model, inputTokens, outputTokens, cachedAt: now };
  writeCacheIndex(index);

  return hash;
}

// ---------- ログ記録 ----------

/**
 * リクエストログの1行を追記。
 */
export function logRequest(record) {
  initStore();
  const line = JSON.stringify({
    t: new Date().toISOString(),
    ...record,
  });
  fs.appendFileSync(logFile(), line + '\n');
}

/**
 * ログを全件読む。
 */
export function readLogs({ since = null, limit = 0 } = {}) {
  initStore();
  try {
    const text = fs.readFileSync(logFile(), 'utf8');
    const lines = text.trim().split('\n').filter(Boolean);
    let records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (since) {
      const sinceDate = new Date(since);
      records = records.filter((r) => new Date(r.t) >= sinceDate);
    }
    records.sort((a, b) => (a.t || '') < (b.t || '') ? -1 : 1);
    if (limit > 0) records = records.slice(0, limit);
    return records;
  } catch {
    return [];
  }
}

// ---------- コスト計算 ----------

/**
 * リクエスト単位のコストを計算。
 * キャッシュヒット = ローカルストアから応答を返すため、LLM呼出しが発生せずコスト0。
 * キャッシュミス = 通常のLLM API 呼出しコスト。
 */
export function estimateCost(inputTokens, outputTokens, { cacheHit = false } = {}) {
  if (cacheHit) return 0; // キャッシュヒットはAPI呼出し不要
  const cost =
    (inputTokens / 1e6) * RATES.input +
    (outputTokens / 1e6) * RATES.output;
  return Math.round(cost * 1e6) / 1e6; // $0.000001精度
}

// ---------- 統計 ----------

/**
 * ログから集計統計を生成。
 */
export function computeStats(logs) {
  if (!logs || logs.length === 0) {
    return {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      hitRate: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      avgLatencyMs: 0,
      totalCostUncached: 0,
      totalCostCached: 0,
      savingsUsd: 0,
      savingsPercent: 0,
    };
  }

  let cacheHits = 0, cacheMisses = 0;
  let totalInputTokens = 0, totalOutputTokens = 0;
  let totalLatencyMs = 0, latencyCount = 0;
  let totalCostUncached = 0, totalCostCached = 0;

  for (const r of logs) {
    const input = r.inputTokens || 0;
    const output = r.outputTokens || 0;
    totalInputTokens += input;
    totalOutputTokens += output;

    if (r.cacheHit) cacheHits++;
    else cacheMisses++;

    if (r.latencyMs) { totalLatencyMs += r.latencyMs; latencyCount++; }

    // キャッシュ無し想定コスト
    totalCostUncached += estimateCost(input, output, { cacheHit: false });
    // 実際のコスト（キャッシュ有り）
    totalCostCached += estimateCost(input, output, { cacheHit: !!r.cacheHit });
  }

  const total = cacheHits + cacheMisses;
  const savingsUsd = Math.max(0, totalCostUncached - totalCostCached);
  const savingsPercent = totalCostUncached > 0
    ? Math.round((savingsUsd / totalCostUncached) * 1000) / 10
    : 0;

  return {
    totalRequests: total,
    cacheHits,
    cacheMisses,
    hitRate: total > 0 ? Math.round((cacheHits / total) * 1000) / 10 : 0,
    totalInputTokens,
    totalOutputTokens,
    avgLatencyMs: latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : 0,
    totalCostUncached: Math.round(totalCostUncached * 1000) / 1000,
    totalCostCached: Math.round(totalCostCached * 1000) / 1000,
    savingsUsd: Math.round(savingsUsd * 1000) / 1000,
    savingsPercent,
  };
}

// ---------- デモ ----------

/**
 * デモシナリオ実行。
 * ブースデザイン案・イベント見積など類似反復プロンプトを模擬。
 */
export function runDemo({ scenario = 'booth-proposal', batchSize = 5 } = {}) {
  const scenarios = {
    'booth-proposal': {
      title: '展示会ブース提案生成',
      prefix: 'あなたは展示会ブースのプロジェクトマネージャー兼デザイナーです。以下のデザインガイドラインに従って提案を生成してください。\n- ブースサイズは標準小間（2.7m×6m）\n- 使用可能な構造材はアルミフレーム（パイプ径28mm/48mm）\n- パネル高さは2.5mまで（天吊り不可）\n- 会社カラーは青と白\n- 商談スペースを最低1卓確保\n',
      suffixes: [
        '提案1: 新製品「Astra-Sol」の展示に最適なブースデザインを3パターン提案。ターゲットは法人営業担当者。',
        '提案2: 「Astra-Sol」は異なるが、同シリーズ「Astra-Luna」の展示ブースデザイン。ブースサイズは同じ。',
        '提案3: サービス紹介ブース。商談重視でクローズドな空間を希望。商談ブース3卓必要。',
        '提案4: パートナーブース。共同出展のため半分はパートナー社のスペース。',
        '提案5: デモ重視のブース。製品を実際に動かせるカウンター2台を設置。',
      ],
    },
    'event-estimate': {
      title: 'イベント見積生成',
      prefix: 'あなたはイベント企画の見積作成者です。以下の条件に基づいて詳細見積を作成してください。\n- イベント種別: 展示会\n- 想定来場者数: 500〜2000人\n- 設営期間: 2日\n- 開催期間: 3日\n- エリア: 東京ビッグサイト\n',
      suffixes: [
        '見積1: 小間ブース（2.7m×6m）基本セット。備品最小構成。予算80万円以下。',
        '見積2: 中規模ブース（9m×6m）カスタムセット。備品充実。予算200万円以下。',
        '見積3: 大規模ブース（12m×9m）フルカスタム。2階建て構造。予算500万円以下。',
        '見積4: 小間ブース + オンライン配信ハイブリッド構成。予算120万円以下。',
        '見積5: 商談特化型ブース（6m×6m）完全個室。予算150万円以下。',
      ],
    },
  };

  const config = scenarios[scenario] || scenarios['booth-proposal'];
  const logs = [];

  for (let i = 0; i < batchSize; i++) {
    const prompt = config.prefix + '\n\n' + config.suffixes[i % config.suffixes.length];
    const hash = promptHash(prompt);
    const isCached = i > 0; // デモでは2件目以降はキャッシュヒット想定
    const simTokens = 300 + Math.round(Math.random() * 100);
    const outputTokens = 400 + Math.round(Math.random() * 200);
    const fullInputTokens = simTokens + 150;

    logs.push({
      t: new Date(Date.now() - (batchSize - i) * 60000).toISOString(),
      prompt: prompt.slice(0, 80) + '...',
      promptHash: hash,
      model: 'openai/gpt-oss-120b',
      inputTokens: fullInputTokens,
      outputTokens,
      latencyMs: isCached ? 400 + Math.round(Math.random() * 200) : 2800 + Math.round(Math.random() * 800),
      cacheHit: isCached,
      scenario: config.title,
    });
  }

  const stats = computeStats(logs);
  return { scenario: config.title, logs, stats };
}

// ---------- CLI ----------

function printHelp() {
  console.log(`LLM Request Cache Store — X-0032 リクエストキャッシング

使い方:
  node tools/llm-cache-store.mjs --request <JSON>
  node tools/llm-cache-store.mjs --stats [--since YYYY-MM-DD]
  node tools/llm-cache-store.mjs --demo [--scenario booth-proposal|event-estimate] [--batch N]
  node tools/llm-cache-store.mjs --cache-stats
  node tools/llm-cache-store.mjs --clear-cache

オプション:
  --request <JSON>      LLMリクエストをキャッシュ経由で実行（JSON: {prompt, system?, model?}）
  --stats               リクエストログから集計
  --since YYYY-MM-DD    --stats で絞り込み
  --demo                デモ実行（キャッシュヒット模擬）
  --scenario <name>     デモシナリオ選択（booth-proposal / event-estimate）
  --batch N             デモのバッチサイズ（既定5）
  --cache-stats         キャッシュインデックス統計
  --clear-cache         キャッシュ全削除
  --help                このヘルプ

環境変数:
  LLM_CACHE_DIR               キャッシュ保存先
  LLM_CACHE_TTL_MS            TTLミリ秒（既定24h）
  LLM_INPUT_COST_PER_M        入力1Mトークン単価（既定$0.25）
  LLM_OUTPUT_COST_PER_M       出力1Mトークン単価（既定$1.25）
  LLM_CACHED_INPUT_COST_PER_M キャッシュ入力1M単価（既定$0.03）
`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) { printHelp(); return; }

  initStore();

  // --request: キャッシュ経由リクエスト（模擬）
  if (args.includes('--request')) {
    const idx = args.indexOf('--request');
    const jsonStr = idx + 1 < args.length ? args[idx + 1] : '';
    if (!jsonStr) { console.error('--request requires JSON argument'); process.exit(2); }
    let req;
    try { req = JSON.parse(jsonStr); } catch { console.error('Invalid JSON'); process.exit(2); }

    const result = lookupCache(req.prompt, { model: req.model || '' });
    if (result.hit) {
      logRequest({ promptHash: result.hash, model: req.model || '', inputTokens: result.entry.inputTokens || 0, outputTokens: result.entry.outputTokens || 0, latencyMs: 0, cacheHit: true, prompt: req.prompt.slice(0, 80) });
      console.log(JSON.stringify({ cacheHit: true, response: result.entry.response, hash: result.hash }));
    } else {
      console.log(JSON.stringify({ cacheHit: false, hash: result.hash, similar: result.similar.slice(0, 3) }));
    }
    return;
  }

  // --demo: デモ実行
  if (args.includes('--demo')) {
    const scenarioArg = args.find((a) => a.startsWith('--scenario='))?.split('=')[1] || '';
    const batchIdx = args.indexOf('--batch');
    const batchSize = batchIdx >= 0 && batchIdx + 1 < args.length ? parseInt(args[batchIdx + 1], 10) || 5 : 5;
    const scenario = scenarioArg || 'booth-proposal';
    const result = runDemo({ scenario, batchSize });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // --stats: 集計
  if (args.includes('--stats')) {
    const sinceIdx = args.indexOf('--since');
    const since = sinceIdx >= 0 && sinceIdx + 1 < args.length ? args[sinceIdx + 1] : null;
    const logs = readLogs({ since });
    const stats = computeStats(logs);
    console.log(JSON.stringify(stats, null, 2));
    // 人間可読サマリ
    console.log(`\n--- リクエストキャッシュ集計 ---`);
    console.log(`総リクエスト: ${stats.totalRequests}`);
    console.log(`キャッシュヒット: ${stats.cacheHits} (${stats.hitRate}%)`);
    console.log(`キャッシュミス: ${stats.cacheMisses}`);
    console.log(`総入力トークン: ${stats.totalInputTokens}`);
    console.log(`総出力トークン: ${stats.totalOutputTokens}`);
    console.log(`平均レイテンシ: ${stats.avgLatencyMs}ms`);
    console.log(`想定コスト（キャッシュ無し）: $${stats.totalCostUncached}`);
    console.log(`実コスト（キャッシュ有り）: $${stats.totalCostCached}`);
    console.log(`削減額: $${stats.savingsUsd} (${stats.savingsPercent}%)`);
    return;
  }

  // --cache-stats: キャッシュインデックス統計
  if (args.includes('--cache-stats')) {
    const index = readCacheIndex();
    const entries = Object.keys(index.entries);
    const now = Date.now();
    let validCount = 0, expiredCount = 0;
    for (const meta of Object.values(index.entries)) {
      if (now - meta.cachedAt < CACHE_TTL_MS) validCount++;
      else expiredCount++;
    }
    console.log(`キャッシュエントリ数: ${entries.length}`);
    console.log(`有効: ${validCount}`);
    console.log(`期限切れ: ${expiredCount}`);
    console.log(`TTL: ${CACHE_TTL_MS / 1000}s (${CACHE_TTL_MS / 3600000}h)`);
    return;
  }

  // --clear-cache: キャッシュ全削除
  if (args.includes('--clear-cache')) {
    const index = readCacheIndex();
    let deleted = 0;
    for (const hash of Object.keys(index.entries)) {
      const fp = cacheEntryPath(hash);
      try { fs.unlinkSync(fp); deleted++; } catch { /* ignore */ }
    }
    fs.writeFileSync(cacheIndexFile(), JSON.stringify({ version: 1, entries: {} }, null, 2), 'utf8');
    console.log(`キャッシュ ${deleted} 件削除`);
    return;
  }

  printHelp();
}

if (isEntry(import.meta.url)) {
  process.exitCode = main();
}