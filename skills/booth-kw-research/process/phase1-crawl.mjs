#!/usr/bin/env node
/**
 * Phase 1: サイトクロール
 *
 * 自社サイト + 競合サイトをクロールし、ページのURL・タイトル・H1・メタディスクリプションを抽出する。
 *
 * 使用法: node process/phase1-crawl.mjs [--config ../data/competitors.json]
 *
 * TODO(codex): 以下の実装が必要
 * - node-html-parser または regex でのHTML解析
 * - robots.txt のパースと遵守
 * - 同一ドメイン内リンクの再帰的クロール（depth制御）
 * - タイムアウト・リトライ処理
 * - クロール間隔の制御（delay_s）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function crawlPage(url, depth, maxDepth, delay, seen) {
  // 実装予定: fetch でページ取得 → HTMLパース → リンク抽出 → 再帰
  // 現状はモック実装
  return [];
}

async function main() {
  const configPath = process.argv[2] || path.join(__dirname, '..', 'data', 'competitors.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const allDomains = [...config.orgiast_domains, ...config.competitors];
  const results = [];
  const seen = new Set();

  for (const domain of allDomains) {
    const pages = await crawlPage(domain, 0, 3, config.settings.crawl_delay_s, seen);
    results.push({ domain, pages });
    console.log(`  ${domain}: ${pages.length} pages`);
  }

  const outPath = path.join(__dirname, '..', 'output', 'crawl-results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Phase 1 complete: ${results.length} sites → ${outPath}`);
}

main().catch(e => {
  console.error('Phase 1 failed:', e.message);
  process.exit(1);
});