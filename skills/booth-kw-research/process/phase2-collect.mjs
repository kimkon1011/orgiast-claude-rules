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
 * TODO(codex): 以下の実装が必要
 * - クロール結果からTF-IDF的なキーワード抽出
 * - 同一キーワードの類似度判定とマージ（閾値: 80%）
 * - GSCデータ（CSV）の読込と統合
 * - 日本語形態素解析（kuromoji.js等）の使用判断
 * - ストップワード除去
 * - カテゴリ分類（data/business-value.json の keyword_category_map を使用）
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

function mergeKeywords(keywords, threshold = 0.8) {
  // 実装予定: 類似度判定とマージ
  // 現状は完全一致のみ統合
  const seen = new Map();
  for (const kw of keywords) {
    if (seen.has(kw.text)) {
      seen.get(kw.text).volume = (seen.get(kw.text).volume || 0) + 1;
    } else {
      seen.set(kw.text, { ...kw, volume: 1 });
    }
  }
  return [...seen.values()];
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

main().catch(e => {
  console.error('Phase 2 failed:', e.message);
  process.exit(1);
});