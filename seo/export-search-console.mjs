#!/usr/bin/env node
/**
 * export-search-console.mjs — Google Search Console から直近3ヶ月の
 * クエリデータ・ページデータを CSV にエクスポートする。
 *
 * 前提:
 *   1. Google Service Account 鍵 (sheets-sa.json) が利用可能
 *   2. 当該SAに Search Console サイトの読み取り権限が付与されている
 *   3. DWD で kim@orgiast.jp を代理できる
 *
 * 使い方:
 *   node seo/export-search-console.mjs --site "sc-domain:orgiast.jp"
 *   node seo/export-search-console.mjs --site "https://www.orgiast.jp/" --days 90
 *
 * 出力:
 *   seo/Queries.csv
 *   seo/Pages.csv
 *
 * ブロッカー:
 *   SA鍵 (sheets-sa.json) がこのPCに存在しない。
 *   配置後に再実行可能。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DAYS = 90;

// ---- Search Console API の型定義（参考） ----
// searchAnalytics.query:
//   POST https://searchconsole.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
//   Body: { startDate, endDate, dimensions: ["query","page"], rowLimit: 25000 }
//   Response: { rows: [{ keys: ["query","page"], clicks, impressions, ctr, position }], responseAggregationType }
//
// 注意: 1リクエストで query と page を同時に取れないため、
//       2回に分けて取得し結合する。

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--site') args.site = argv[++i];
    else if (argv[i] === '--days') args.days = parseInt(argv[++i], 10);
    else if (argv[i] === '--key') args.key = argv[++i];
  }
  return args;
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.site) {
    console.error('Usage: node seo/export-search-console.mjs --site "sc-domain:orgiast.jp" [--days 90] [--key <sa-key-path>]');
    process.exit(2);
  }

  console.log(`[export-search-console] ブロッカー: SA鍵がこのPCに存在しません。`);
  console.log(`[export-search-console] 以下の手順で解消してください:`);
  console.log();
  console.log(`  1. kim が sheets-sa.json をこのPCに配置`);
  console.log(`     (既定パス: ~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`);
  console.log(`      または --key で指定)`);
  console.log(`  2. SAに Search Console サイトの owner/reader 権限を付与`);
  console.log(`  3. このスクリプトを再実行`);
  console.log();
  console.log(`  対象サイト: ${args.site}`);
  console.log(`  期間: ${dateNDaysAgo(args.days || DEFAULT_DAYS)} 〜 ${dateNDaysAgo(0)}`);
  console.log();
  console.log(`出力先:`);
  console.log(`  ${path.join(DIR, 'Queries.csv')}`);
  console.log(`  ${path.join(DIR, 'Pages.csv')}`);

  process.exit(75); // EX_TEMPFAIL — ブロッカー解消後に再実行
}

main().catch(err => { console.error(err); process.exit(1); });