#!/usr/bin/env node
/**
 * Phase 2: キーワード収集・統合
 *
 * Phase 1のクロール結果からキーワード候補を抽出し、重複排除・統合する。
 *
 * 使用法:
 *   node process/phase2-collect.mjs
 *   node process/phase2-collect.mjs --dry-run <outdir>
 *
 * TODO(codex): 残実装
 * - GSCデータ（CSV）の読込と統合（ブロック中: GSC アクセス要）
 * - 日本語形態素解析（kuromoji.js等）の使用判断（現状は正規表現抽出）
 *
 * 実装済み: 正規表現キーワード抽出+ストップワード除去、類似度80%マージ（charSimilarity）、カテゴリ分類
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 日本語キーワード抽出（簡易版: 漢字・カタカナ連続を抽出） */
function extractKeywords(text) {
  if (!text) return [];
  // 日本語の単語らしき連続（漢字・カタカナ・ひらがな）を抽出
  const words = text.match(/[一-鿿゠-ヿ぀-ゟ·ー]{2,}/g) || [];
  // 頻出汎用語を除去
  const stopWords = new Set(['オージャスト', '一覧']);
  return [...new Set(words)].filter(w => !stopWords.has(w)).map(w => ({ text: w }));
}

/** 文字単位類似度（1 - 編集距離/maxLen）。0..1。同一文字列は 1 */
export function charSimilarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  // 編集距離（Levenshtein、O(m*n)。キーワード長は短いので十分）
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = new Array(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** 類似度0.8以上はマージ（代表テキストは長い方、volumeは合算）。完全一致も同経路 */
export function mergeKeywords(keywords, threshold = 0.8) {
  const groups = [];
  for (const kw of keywords) {
    const g = groups.find(grp => charSimilarity(grp.text, kw.text) >= threshold);
    if (g) {
      if (kw.text.length > g.text.length) g.text = kw.text;
      g.volume = (g.volume || 0) + (kw.volume || 1);
      g.variants = [...(g.variants || []), kw.text];
      if (!g.source && kw.source) g.source = kw.source;
    } else {
      groups.push({ ...kw, volume: kw.volume || 1, variants: [] });
    }
  }
  return groups;
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const dryRunIndex = process.argv.indexOf('--dry-run');
  const outdir = isDryRun && dryRunIndex + 1 < process.argv.length
    ? path.resolve(process.argv[dryRunIndex + 1])
    : null;
  if (isDryRun && !outdir) {
    console.error('Usage: node process/phase2-collect.mjs --dry-run <outdir>');
    process.exit(1);
  }

  const crawlPath = isDryRun
    ? path.join(outdir, 'crawl-results.json')
    : path.join(__dirname, '..', 'output', 'crawl-results.json');
  const crawlData = JSON.parse(fs.readFileSync(crawlPath, 'utf-8'));
  const bizValuePath = path.join(__dirname, '..', 'data', 'business-value.json');
  const bizValue = JSON.parse(fs.readFileSync(bizValuePath, 'utf-8'));

  let allKeywords = [];
  for (const site of crawlData) {
    for (const page of site.pages) {
      const kw = extractKeywords(`${page.title || ''} ${page.h1 || ''} ${page.description || ''}`);
      allKeywords.push(...kw.map(k => ({ ...k, source: site.domain, url: page.url })));
    }
  }

  const merged = mergeKeywords(allKeywords);
  const categorized = merged.map(kw => ({
    text: kw.text,
    volume: kw.volume,
    category: Object.entries(bizValue.keyword_category_map)
      .find(([key]) => kw.text.includes(key))?.[1] || '未分類',
    source: kw.source,
  }));

  const outPath = isDryRun
    ? path.join(outdir, 'raw-keywords.json')
    : path.join(__dirname, '..', 'output', 'raw-keywords.json');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(categorized, null, 2));
  console.log(`Phase 2 complete: ${categorized.length} unique keywords → ${outPath}`);
}

// 直接実行時のみ main() を走らせる（テストから import された場合は実行しない）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('Phase 2 failed:', e.message);
    process.exit(1);
  });
}