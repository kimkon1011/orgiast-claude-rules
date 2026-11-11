#!/usr/bin/env node
/**
 * ahrefs-gsc-priority.mjs — Ahrefs Site Audit × Search Console データ統合・優先度判定
 *
 * 目的:
 *   Ahrefs Site Audit のエラー一覧と Search Console のページ別データを統合し、
 *   AI による優先度判定を行う。修正優先度 = f(問題の重大性, 検索流入影響, 影響範囲)。
 *
 * 入力 (CSV):
 *   1. --ahrefs: Ahrefs Site Audit export CSV
 *      想定カラム: Issue, URL, Severity, Affected Pages, Category, Details
 *   2. --gsc: Search Console ページ別 CSV
 *      想定カラム: Page, Clicks, Impressions, CTR, Position
 *   3. --output: 出力先 (省略時は stdout)
 *
 * 出力:
 *   Markdown テーブル: 対象URL / エラー内容 / 検索流入 / 影響範囲 / 修正優先度 / 判断理由
 *
 * 使い方:
 *   node seo/ahrefs-gsc-priority.mjs \
 *     --ahrefs seo/ahrefs-site-audit.csv \
 *     --gsc seo/pages.csv \
 *     --output outputs/X-0029/priority-table.md
 *
 *   サンプルデータ生成:
 *   node seo/ahrefs-gsc-priority.mjs --sample > outputs/X-0029/sample-data.csv
 *
 *   サンプルデータでテスト実行:
 *   node seo/ahrefs-gsc-priority.mjs --ahrefs outputs/X-0029/sample-ahrefs.csv --gsc outputs/X-0029/sample-gsc.csv
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---- 重み設定 ----
const WEIGHTS = {
  severity: { error: 3, warning: 2, notice: 1 },
  traffic: { high: 3, medium: 2, low: 1 },
  scope: { high: 3, medium: 2, low: 1 },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--ahrefs') args.ahrefs = argv[++i];
    else if (argv[i] === '--gsc') args.gsc = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--sample') args.sample = true;
  }
  return args;
}

/** CSV パース（簡易、引用符・改行非対応） */
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ''; });
    return row;
  });
  return { headers, rows };
}

/** 数字パース */
function parseNum(v) {
  const n = parseInt(v.replace(/[,]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

/** 影響範囲レベル判定 */
function scopeLevel(affectedPages) {
  const n = parseNum(affectedPages);
  if (n >= 50) return 'high';
  if (n >= 10) return 'medium';
  return 'low';
}

/** トラフィックレベル判定 */
function trafficLevel(clicks, impressions) {
  const c = parseNum(clicks);
  const i = parseNum(impressions);
  if (c >= 100 || i >= 10000) return 'high';
  if (c >= 10 || i >= 1000) return 'medium';
  return 'low';
}

/** 優先度スコア計算 */
function calcPriority(row) {
  const sev = (row.severity || '').toLowerCase();
  const sevScore = WEIGHTS.severity[sev] || 1;
  const traf = trafficLevel(row.clicks, row.impressions);
  const trafScore = WEIGHTS.traffic[traf] || 1;
  const scp = scopeLevel(row.affectedPages);
  const scpScore = WEIGHTS.scope[scp] || 1;
  return sevScore * trafScore * scpScore;
}

/** 優先度ラベル */
function priorityLabel(score) {
  if (score >= 18) return '🔴 緊急';
  if (score >= 9) return '🟠 高';
  if (score >= 4) return '🟡 中';
  return '🟢 低';
}

/** AI による判断理由生成（ルールベース＋重要度判定） */
function generateReason(row, score) {
  const sev = (row.severity || '').toLowerCase();
  const trafLvl = trafficLevel(row.clicks, row.impressions);
  const scpLvl = scopeLevel(row.affectedPages);
  const parts = [];

  if (sev === 'error') parts.push('Error: クローラビリティ/インデックスに直接影響');
  else if (sev === 'warning') parts.push('Warning: 軽微だが累積リスクあり');
  else parts.push('Notice: 改善推奨');

  if (trafLvl === 'high') parts.push('検索流入大: 流入減少リスク');
  else if (trafLvl === 'medium') parts.push('検索流入中: 改善で効果期待');
  else parts.push('検索流入小: 優先度低');

  if (scpLvl === 'high') parts.push(`影響範囲大 (${row.affectedPages}ページ)`);
  else if (scpLvl === 'medium') parts.push(`影響範囲中 (${row.affectedPages}ページ)`);
  else parts.push(`影響範囲小 (${row.affectedPages}ページ)`);

  return parts.join('／');
}

/** メイン処理 */
async function main() {
  const args = parseArgs(process.argv);

  if (args.sample) {
    generateSampleData();
    return;
  }

  if (!args.ahrefs) {
    console.error('Usage: node seo/ahrefs-gsc-priority.mjs --ahrefs <csv> --gsc <csv> [--output <file>]');
    console.error('       node seo/ahrefs-gsc-priority.mjs --sample');
    process.exit(2);
  }

  // 1. Ahrefs CSV 読み込み
  const ahrefsText = fs.readFileSync(args.ahrefs, 'utf-8');
  const ahrefs = parseCSV(ahrefsText);

  // 2. GSC CSV 読み込み
  const gscText = args.gsc ? fs.readFileSync(args.gsc, 'utf-8') : '';
  const gsc = gscText ? parseCSV(gscText) : { headers: [], rows: [] };

  // 3. URL をキーに統合
  const gscByUrl = {};
  for (const row of gsc.rows) {
    const url = (row.Page || row.page || row.URL || row.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    gscByUrl[url] = row;
  }

  const merged = ahrefs.rows.map(row => {
    const url = (row.URL || row.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const gscRow = gscByUrl[url] || {};
    return {
      url: row.URL || row.url || '',
      issue: row.Issue || row['Issue Name'] || row['Issue'] || '',
      severity: row.Severity || row['Severity'] || '',
      affectedPages: row['Affected Pages'] || row['Affected Pages Count'] || row.affectedPages || '1',
      category: row.Category || row['Category'] || '',
      details: row.Details || row['Details'] || '',
      clicks: gscRow.Clicks || gscRow.clicks || '0',
      impressions: gscRow.Impressions || gscRow.impressions || '0',
      ctr: gscRow.CTR || gscRow.ctr || '',
      position: gscRow.Position || gscRow.position || '',
    };
  });

  // 4. 優先度計算
  const scored = merged.map(row => ({
    ...row,
    score: calcPriority(row),
    priority: '',
    reason: '',
  }));
  scored.forEach(row => {
    row.priority = priorityLabel(row.score);
    row.reason = generateReason(row, row.score);
  });

  // 5. スコア降順ソート
  scored.sort((a, b) => b.score - a.score);

  // 6. 出力
  const now = new Date().toISOString().slice(0, 10);
  let output = `# Ahrefs × Search Console 統合優先度テーブル\n\n`;
  output += `**生成日**: ${now}\n`;
  output += `**対象**: www.orgiast.jp\n`;
  output += `**総エラー件数**: ${scored.length}\n\n`;

  output += `| # | 対象URL | エラー内容 | 重大度 | 検索流入（クリック/表示） | 影響範囲 | 修正優先度 | 判断理由 |\n`;
  output += `|---|---------|-----------|--------|--------------------------|---------|-----------|---------|\n`;

  scored.forEach((row, i) => {
    const url = row.url.length > 50 ? row.url.slice(0, 47) + '...' : row.url;
    const issue = row.issue.length > 40 ? row.issue.slice(0, 37) + '...' : row.issue;
    const traffic = `${row.clicks}/${row.impressions}`;
    output += `| ${i + 1} | \`${url}\` | ${issue} | ${row.severity} | ${traffic} | ${row.affectedPages}ページ | ${row.priority} | ${row.reason} |\n`;
  });

  // 統計サマリ
  output += `\n## 集計\n\n`;
  const byPriority = {};
  scored.forEach(r => {
    byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
  });
  for (const [label, count] of Object.entries(byPriority)) {
    output += `- ${label}: ${count}件\n`;
  }

  output += `\n## カテゴリ別内訳\n\n`;
  const byCategory = {};
  scored.forEach(r => {
    const cat = r.category || '未分類';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  });
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    output += `- ${cat}: ${count}件\n`;
  }

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, output, 'utf-8');
    console.log(`✅ 出力完了: ${args.output}`);
  } else {
    console.log(output);
  }
}

/** サンプルデータ生成 */
function generateSampleData() {
  const dir = path.join(DIR, '..', 'outputs', 'X-0029');
  fs.mkdirSync(dir, { recursive: true });

  // Ahrefs サンプル
  const ahrefsSample = `URL,Issue,Severity,Affected Pages,Category,Details
https://www.orgiast.jp/,Missing meta description,Error,1,Meta Tags,トップページにmeta descriptionがない
https://www.orgiast.jp/topics,Missing H1 tag,Warning,1,Headings,ページにH1タグがない
https://www.orgiast.jp/contactus,Broken link,Error,3,Links,問い合わせページにリンク切れ3件
https://www.orgiast.jp/event/,Duplicate title tag,Warning,1,Duplicates,他ページと同じタイトル
https://www.orgiast.jp/company,Slow page load,Warning,1,Performance,読み込み速度が遅い (4.2s)
https://www.orgiast.jp/newsrelease,Missing alt text,Notice,12,Images,12件の画像にalt属性なし
https://www.orgiast.jp/creative,Low text ratio,Warning,1,Content,テキスト比率が低い
https://www.orgiast.jp/recruiting,Duplicate H1,Notice,1,Headings,他ページと同じH1
https://www.orgiast.jp/services/flow,Missing canonical tag,Warning,1,Canonical,canonicalタグがない
https://www.orgiast.jp/clients/,Thin content,Warning,1,Content,コンテンツ量が不足
https://www.orgiast.jp/event/category/online,4xx error,Error,8,HTTP Status,8件の4xxエラー
https://www.orgiast.jp/wp/wp-content/uploads/,Directory listing enabled,Error,1,Security,ディレクトリリスティング有効
https://www.orgiast.jp/newsrelease/page/2,Duplicate content,Warning,2,Duplicates,重複コンテンツ
https://www.orgiast.jp/creative/graphic,Missing Open Graph tags,Notice,1,Meta Tags,OGPタグ不足
https://www.orgiast.jp/event/category/offline,Missing schema markup,Notice,1,Schema,構造化データ不足
`;
  fs.writeFileSync(path.join(dir, 'sample-ahrefs.csv'), ahrefsSample, 'utf-8');

  // GSC サンプル
  const gscSample = `Page,Clicks,Impressions,CTR,Position
https://www.orgiast.jp/,1520,48500,3.13%,8.2
https://www.orgiast.jp/topics,340,12500,2.72%,11.5
https://www.orgiast.jp/contactus,890,22100,4.03%,6.8
https://www.orgiast.jp/event/,210,8900,2.36%,14.2
https://www.orgiast.jp/company,180,7600,2.37%,15.8
https://www.orgiast.jp/newsrelease,95,4200,2.26%,18.3
https://www.orgiast.jp/creative,67,3100,2.16%,19.7
https://www.orgiast.jp/recruiting,45,2100,2.14%,22.1
https://www.orgiast.jp/services/flow,32,1800,1.78%,24.5
https://www.orgiast.jp/clients/,28,1500,1.87%,25.3
`;
  fs.writeFileSync(path.join(dir, 'sample-gsc.csv'), gscSample, 'utf-8');

  console.log(`✅ サンプルデータ生成完了:`);
  console.log(`   ${path.join(dir, 'sample-ahrefs.csv')}`);
  console.log(`   ${path.join(dir, 'sample-gsc.csv')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
