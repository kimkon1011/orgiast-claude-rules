#!/usr/bin/env node
/**
 * gsc-keyword-finder.mjs — GSC高IMP低CTRキーワード検出器
 *
 * Google Search Console API から指定サイトの直近クエリデータを取得し、
 * インプレッションが高いがCTR/掲載順位が低いキーワードを抽出する。
 *
 * X-0011: gumツール代替（gumがWindows非対応のためNode.js Google API Clientで実装）
 *
 * 使い方:
 *   node tools/gsc-keyword-finder.mjs [--site https://www.orgiast.jp] [--days 30]
 *     [--min-impressions 1000] [--max-position 30] [--max-ctr 0.05]
 *     [--output json|table|markdown] [--limit 10]
 *
 * 依存:
 *   npm: googleapis, @googleapis/searchconsole
 *   認証: aujust-sheets-reader.json (OAuth 2.0)
 */

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===== 設定 =====
const DEFAULTS = {
  siteUrl: 'https://www.orgiast.jp',
  days: 30,
  minImpressions: 1000,
  maxPosition: 30,
  maxCtr: 0.05,   // 5%
  limit: 15,
  output: 'markdown',
};

// 認証鍵の探索パス
const KEY_CANDIDATES = [
  resolve(__dirname, '../keys/aujust-sheets-reader.json'),
  resolve(process.env.HOME || process.env.USERPROFILE || 'C:/Users/kimko', '.claude', 'keys', 'aujust-sheets-reader.json'),
  resolve(process.env.HOME || process.env.USERPROFILE || 'C:/Users/kimko', '.claude', 'gcp-oauth.json'),
];

// ===== GSC API クライアント =====
async function getAuthClient() {
  const keyPath = KEY_CANDIDATES.find(f => existsSync(f));
  if (!keyPath) {
    throw new Error(
      '認証鍵が見つかりません。以下のいずれかに配置してください:\n' +
      KEY_CANDIDATES.map(f => `  - ${f}`).join('\n') +
      '\n\nまたは --key-path <path> で指定。'
    );
  }

  const key = JSON.parse(readFileSync(keyPath, 'utf8'));

  // サービスアカウント or OAuth 2.0 クライアント
  if (key.client_email) {
    // サービスアカウント
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    return auth;
  } else if (key.installed || key.web) {
    // OAuth 2.0 デスクトップクライアント
    const { OAuth2Client } = google.auth;
    const clientId = key.installed?.client_id || key.web?.client_id;
    const clientSecret = key.installed?.client_secret || key.web?.client_secret;
    const redirectUri = key.installed?.redirect_uris?.[0] || 'http://localhost';

    const auth = new OAuth2Client({ clientId, clientSecret, redirectUri });

    // トークンファイルがあれば読み込み
    const tokenPath = resolve(__dirname, '../keys/gsc-token.json');
    if (existsSync(tokenPath)) {
      const tokens = JSON.parse(readFileSync(tokenPath, 'utf8'));
      auth.setCredentials(tokens);
    } else {
      console.error('⚠ トークンファイルがありません:', tokenPath);
      console.error('  初回は認証URLにブラウザでアクセスし、トークンを保存してください。');
      console.error('  認証URLを生成するには --auth フラグを付けて実行。');
      throw new Error('GSC_TOKEN_NOT_FOUND');
    }
    return auth;
  }

  throw new Error('認証鍵の形式が不明です（サービスアカウント or OAuth 2.0 クライアント）');
}

async function fetchSearchAnalytics(auth, siteUrl, days) {
  const searchconsole = google.searchconsole({ version: 'v1', auth });

  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const formatDate = (d) => d.toISOString().split('T')[0];

  const request = {
    siteUrl,
    requestBody: {
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      dimensions: ['query'],
      rowLimit: 25000,
    },
  };

  const response = await searchconsole.searchanalytics.query(request);
  return response.data.rows || [];
}

function analyzeKeywords(rows, options) {
  const { minImpressions, maxPosition, maxCtr } = options;

  const candidates = rows
    .filter(row => {
      const impressions = row.impressions || 0;
      const position = row.position || 999;
      const ctr = row.ctr || 0;
      return impressions >= minImpressions && position >= maxPosition && ctr <= maxCtr;
    })
    .map(row => ({
      keyword: row.keys[0],
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: row.ctr,
      position: row.position,
      // 改善余地スコア（高いほど改善効果大）
      opportunityScore: Math.round(
        (row.impressions * (1 - row.ctr) * (1 - Math.min(row.position / 100, 1))) / 100
      ),
    }))
    .sort((a, b) => b.opportunityScore - a.opportunityScore);

  return candidates;
}

function formatMarkdown(candidates, options) {
  const lines = [
    `# GSC 高IMP低CTRキーワード分析`,
    ``,
    `| 調査日 | ${new Date().toISOString().split('T')[0]} |`,
    `|--------|------|`,
    `| 対象サイト | ${options.siteUrl} |`,
    `| 分析期間 | 直近${options.days}日 |`,
    `| 抽出条件 | IMP≥${options.minImpressions} / 順位≥${options.maxPosition}位 / CTR≤${(options.maxCtr * 100).toFixed(1)}% |`,
    `| 該当件数 | ${candidates.length}件 |`,
    ``,
    `## 改善候補キーワード`,
    ``,
    `| # | キーワード | インプレッション | クリック | CTR | 掲載順位 | 改善スコア |`,
    `|---|-----------|----------------:|--------:|----:|--------:|----------:|`,
  ];

  candidates.slice(0, options.limit).forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${c.keyword} | ${c.impressions.toLocaleString()} | ${c.clicks} | ${(c.ctr * 100).toFixed(2)}% | ${c.position.toFixed(1)}位 | ${c.opportunityScore.toLocaleString()} |`
    );
  });

  lines.push(``);
  lines.push(`## おすすめアクション`);
  lines.push(``);
  lines.push(`今朝のガイド作成候補（展示会ブース関連を優先）:`);
  lines.push(``);

  const boothKeywords = candidates.filter(c =>
    /展示会|ブース|イベント|出展|小間|装飾|設営|施工/.test(c.keyword)
  );
  const targetList = boothKeywords.length > 0 ? boothKeywords : candidates;

  targetList.slice(0, 3).forEach((c, i) => {
    lines.push(`${i + 1}. **${c.keyword}** — IMP ${c.impressions.toLocaleString()} / ${c.position.toFixed(1)}位 / CTR ${(c.ctr * 100).toFixed(2)}%`);
    lines.push(`   → ガイド記事でカバーすれば +${Math.round(c.impressions * 0.05)}クリック見込`);
  });

  return lines.join('\n');
}

function formatTable(candidates, options) {
  const lines = [
    `Keyword|IMP|Clicks|CTR|Position|Score`,
    `-------|---|------|---|---|-----`,
  ];
  candidates.slice(0, options.limit).forEach(c => {
    lines.push(`${c.keyword}|${c.impressions}|${c.clicks}|${(c.ctr * 100).toFixed(2)}%|${c.position.toFixed(1)}|${c.opportunityScore}`);
  });
  return lines.join('\n');
}

// ===== CLI =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--site': opts.siteUrl = args[++i]; break;
      case '--days': opts.days = parseInt(args[++i]); break;
      case '--min-impressions': opts.minImpressions = parseInt(args[++i]); break;
      case '--max-position': opts.maxPosition = parseInt(args[++i]); break;
      case '--max-ctr': opts.maxCtr = parseFloat(args[++i]); break;
      case '--limit': opts.limit = parseInt(args[++i]); break;
      case '--output': opts.output = args[++i]; break;
      case '--auth': opts.authOnly = true; break;
      case '--key-path': opts.keyPath = args[++i]; break;
      case '--help':
        console.log(`使い方: gsc-keyword-finder.mjs [options]
  --site <url>            対象サイト (default: ${DEFAULTS.siteUrl})
  --days <n>              分析期間 (default: ${DEFAULTS.days})
  --min-impressions <n>   最小IMP (default: ${DEFAULTS.minImpressions})
  --max-position <n>      最大順位 (default: ${DEFAULTS.maxPosition})
  --max-ctr <n>          最大CTR (default: ${DEFAULTS.maxCtr})
  --limit <n>             出力件数 (default: ${DEFAULTS.limit})
  --output <format>      出力形式 (json|table|markdown, default: ${DEFAULTS.output})
  --auth                  認証のみ実行（トークン取得）
  --key-path <path>       認証鍵のパスを指定
  --help                  このヘルプ`);
        process.exit(0);
    }
  }

  if (opts.keyPath) {
    KEY_CANDIDATES.unshift(resolve(opts.keyPath));
  }

  return opts;
}

// ===== メイン =====
async function main() {
  const options = parseArgs();

  // 認証のみモード
  if (options.authOnly) {
    console.log('認証モード: ブラウザで以下のURLにアクセスし、トークンを keys/gsc-token.json に保存してください。');
    const auth = await getAuthClient();
    if (auth.generateAuthUrl) {
      const url = auth.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/webmasters.readonly'],
      });
      console.log('\n' + url + '\n');
    } else {
      console.log('サービスアカウントのためブラウザ認証は不要です。');
    }
    return;
  }

  console.error(`🔍 GSC キーワード分析開始: ${options.siteUrl}`);
  console.error(`   分析期間: 直近${options.days}日`);
  console.error(`   条件: IMP≥${options.minImpressions} / 順位≥${options.maxPosition}位 / CTR≤${(options.maxCtr * 100).toFixed(1)}%`);

  // 認証
  console.error('🔑 認証中...');
  const auth = await getAuthClient();

  // GSC データ取得
  console.error('📊 データ取得中...');
  const rows = await fetchSearchAnalytics(auth, options.siteUrl, options.days);
  console.error(`   取得行数: ${rows.length}`);

  // 分析
  console.error('📈 分析中...');
  const candidates = analyzeKeywords(rows, options);
  console.error(`   候補件数: ${candidates.length}`);

  // 出力
  switch (options.output) {
    case 'json':
      console.log(JSON.stringify({ candidates: candidates.slice(0, options.limit), total: candidates.length, options }, null, 2));
      break;
    case 'table':
      console.log(formatTable(candidates, options));
      break;
    case 'markdown':
    default:
      console.log(formatMarkdown(candidates, options));
      break;
  }

  console.error(`\n✅ 完了 (${new Date().toISOString()})`);
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
