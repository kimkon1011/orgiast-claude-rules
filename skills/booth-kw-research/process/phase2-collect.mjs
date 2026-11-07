#!/usr/bin/env node
/**
 * Phase 2: キーワード収集・統合
 *
 * Phase 1のクロール結果からキーワード候補を抽出し、重複排除・統合する。
 *
 * 使用法: node process/phase2-collect.mjs
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

function extractKeywords(text) {
  // 実装予定: テキストからキーワード抽出（日本語対応）
  // 現状はプレースホルダ
  return [];
}

function mergeKeywords(keywords, threshold = 0.8) {
  // 実装予定: 類似度判定とマージ
  return keywords;
}

async function main() {
  const crawlPath = path.join(__dirname, '..', 'output', 'crawl-results.json');
  const crawlData = JSON.parse(fs.readFileSync(crawlPath, 'utf-8'));
  const bizValuePath = path.join(__dirname, '..', 'data', 'business-value.json');
  const bizValue = JSON.parse(fs.readFileSync(bizValuePath, 'utf-8'));

  const allKeywords = [];
  for (const site of crawlData) {
    for (const page of site.pages) {
      const kw = extractKeywords(`${page.title || ''} ${page.h1 || ''} ${page.description || ''}`);
      allKeywords.push(...kw.map(k => ({ ...k, source: site.domain, url: page.url })));
    }
  }

  const merged = mergeKeywords(allKeywords);
  const categorized = merged.map(kw => ({
    ...kw,
    category: Object.entries(bizValue.keyword_category_map)
      .find(([key]) => kw.text.includes(key))?.[1] || '未分類',
  }));

  const outPath = path.join(__dirname, '..', 'output', 'raw-keywords.json');
  fs.writeFileSync(outPath, JSON.stringify(categorized, null, 2));
  console.log(`Phase 2 complete: ${categorized.length} unique keywords → ${outPath}`);
}

main().catch(e => {
  console.error('Phase 2 failed:', e.message);
  process.exit(1);
});