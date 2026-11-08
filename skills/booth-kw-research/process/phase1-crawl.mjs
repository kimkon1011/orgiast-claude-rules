#!/usr/bin/env node
/**
 * Phase 1: サイトクロール
 *
 * 自社サイト + 競合サイトをクロールし、ページのURL・タイトル・H1・メタディスクリプションを抽出する。
 *
 * 使用法:
 *   node process/phase1-crawl.mjs
 *   node process/phase1-crawl.mjs --dry-run <outdir>   (dry-run: test/fixtures から固定サンプルを読んで出力)
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
const DRY_RUN_MOCK_DATA = [
  { url: 'https://orgiast.jp/', title: 'オージャスト | 展示会ブース制作・イベント企画', h1: '展示会ブース制作ならオージャスト', description: '展示会ブース制作・イベント企画のオージャスト' },
  { url: 'https://orgiast.jp/service', title: 'サービス一覧 | オージャスト', h1: 'サービス一覧', description: '展示会ブース制作、Reブース、イベントプロデュース' },
  { url: 'https://orgiast.jp/service/booth', title: '展示会ブース制作 | オージャスト', h1: '展示会ブース制作', description: '企画・デザイン・施工・運営までトータルサポート' },
  { url: 'https://rebooth.co.jp/', title: 'Reブース | リユース展示会ブース', h1: 'Reブース - サステナブルな展示会ブース', description: 'SDGsに対応したリユース展示会ブースのレンタル・販売' },
];

async function crawlPage(url, depth, maxDepth, delay, seen) {
  // 実装予定: fetch でページ取得 → HTMLパース → リンク抽出 → 再帰
  // 現状はモック実装
  return [];
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const dryRunIndex = process.argv.indexOf('--dry-run');
  const outdir = isDryRun && dryRunIndex + 1 < process.argv.length
    ? path.resolve(process.argv[dryRunIndex + 1])
    : null;

  if (isDryRun && !outdir) {
    console.error('Usage: node process/phase1-crawl.mjs --dry-run <outdir>');
    process.exit(1);
  }

  // --dry-run とその値を argv から除外して設定ファイルパスを取得
  const rawArgs = process.argv.slice(2);
  const filteredArgs = rawArgs.filter((a, i, arr) => {
    if (a === '--dry-run') return false;
    if (i > 0 && arr[i - 1] === '--dry-run') return false;
    return true;
  });
  const configPath = filteredArgs[0] || path.join(__dirname, '..', 'data', 'competitors.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  let results;
  if (isDryRun) {
    // Dry-run: ネットワークを使わず固定モックデータを使用
    const allDomains = [...config.orgiast_domains, ...config.competitors];
    results = allDomains.map(domain => {
      const domainPages = DRY_RUN_MOCK_DATA.filter(p => p.url.startsWith(domain));
      return { domain, pages: domainPages };
    });
    console.log('  [dry-run] using mock data');
  } else {
    const allDomains = [...config.orgiast_domains, ...config.competitors];
    results = [];
    const seen = new Set();
    for (const domain of allDomains) {
      const pages = await crawlPage(domain, 0, 3, config.settings.crawl_delay_s, seen);
      results.push({ domain, pages });
      console.log(`  ${domain}: ${pages.length} pages`);
    }
  }

  const outPath = isDryRun
    ? path.join(outdir, 'crawl-results.json')
    : path.join(__dirname, '..', 'output', 'crawl-results.json');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Phase 1 complete: ${results.length} sites → ${outPath}`);
}

main().catch(e => {
  console.error('Phase 1 failed:', e.message);
  process.exit(1);
});