#!/usr/bin/env node

/**
 * SEOスキル導入 少数ページテスト手順（X-0049）
 *
 * Search Console CSV データを用いて、3〜5ページのSEOスキル適用前後を比較する
 * 測定フレームワーク。GSC API が使えない環境でも手動エクスポート CSV で動作する。
 *
 * 使い方:
 *   node tools/seo-small-page-test.mjs plan \
 *     --gsc-pages gsc-pages.csv --gsc-queries gsc-queries.csv \
 *     --keywords "展示会ブース,小規模ブース,イベント企画" \
 *     --output plan.md
 *
 *   node tools/seo-small-page-test.mjs measure \
 *     --before before.json --after after.json --output report.md
 *
 *   node tools/seo-small-page-test.mjs track-ai-citations \
 *     --domain example.com --queries "展示会ブース 費用" \
 *     --output citations.md
 *
 *   node tools/seo-small-page-test.mjs mock-plan    # モックデータでテスト
 *   node tools/seo-small-page-test.mjs mock-report  # モック比較レポート
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// =========================================================================
// CSVパーサ（既存ツールと同じ実装）
// =========================================================================

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); if (row.some(v => v !== '')) rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
  return rows;
}

function csvRowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
    return obj;
  });
}

// =========================================================================
// GSCデータ解析
// =========================================================================

const GSC_PAGES_EXPECTED_COLS = ['url', 'clicks', 'impressions', 'ctr', 'position'];
const GSC_QUERIES_EXPECTED_COLS = ['query', 'clicks', 'impressions', 'ctr', 'position'];

function parseGscPagesCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCsv(text);
  return csvRowsToObjects(rows);
}

function parseGscQueriesCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCsv(text);
  return csvRowsToObjects(rows);
}

// =========================================================================
// ページ選定ロジック（Phase: Plan）
// =========================================================================

/**
 * GSCデータからSEO改善テスト対象の3〜5ページを選定する。
 * 選定条件:
 *   1. ポジション 5〜20（改善余地が大きく、変動の測定が容易）
 *   2. 指定されたキーワードに関連するURL
 *   3. インプレッション降順（露出が多いページを優先）
 *   4. 最大5ページに絞る
 */
function selectTestPages(pages, queries, keywords, maxPages = 5) {
  // ページデータを数値化
  const pageData = pages.map(p => ({
    url: p.url || p.top_url || p.page,
    clicks: parseInt(p.clicks, 10) || 0,
    impressions: parseInt(p.impressions, 10) || 0,
    ctr: parseFloat(p.ctr) || 0,
    position: parseFloat(p.position) || 999,
  })).filter(p => p.url);

  // ポジション5〜20でフィルタ
  const candidates = pageData.filter(p => p.position >= 5 && p.position <= 20);

  // キーワードフィルタ
  const kwList = keywords ? keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) : [];

  let filtered = candidates;

  if (kwList.length > 0) {
    // 第一パス: URLにキーワードが含まれているか
    const urlMatch = candidates.filter(p =>
      kwList.some(kw => p.url.toLowerCase().includes(kw))
    );

    if (urlMatch.length > 0) {
      filtered = urlMatch;
    } else if (queries && queries.length > 0) {
      // 第二パス: クエリテキストにキーワードが含まれているクエリ行があるか確認
      const matchedQueryRows = queries.filter(q => {
        const queryText = (q.query || q.top_queries || '').toLowerCase();
        return kwList.some(kw => queryText.includes(kw));
      });

      if (matchedQueryRows.length === 0) {
        // どのクエリにもキーワードが含まれていない → 該当なし
        filtered = [];
      } else {
        // マッチしたクエリ行からURLを抽出
        const queryUrls = new Set();
        matchedQueryRows.forEach(q => {
          const u = q.url || q.page || q.top_url;
          if (u) queryUrls.add(u);
        });

        if (queryUrls.size > 0) {
          filtered = candidates.filter(p => queryUrls.has(p.url));
        }
        // クエリにはマッチしたがURL列がない場合 → 全候補を返す（キーワード該当ページはあるがURL特定できない）
      }
    }
    // filtered が空なら全候補を返す（絞り込みが効かなかった）
  }

  // インプレッション降順でソート
  filtered.sort((a, b) => b.impressions - a.impressions);

  // 最大N件
  const selected = filtered.slice(0, maxPages);

  // 各ページのクエリ情報を付加
  return selected.map(p => {
    const relatedQueries = queries.filter(q => {
      const query = q.query || q.top_queries || '';
      return p.url.toLowerCase().includes(query.toLowerCase())
        || query.split(' ').some(word => p.url.toLowerCase().includes(word.toLowerCase()));
    }).slice(0, 5);
    return {
      ...p,
      pageQueries: relatedQueries.map(q => ({
        query: q.query || q.top_queries || '',
        clicks: parseInt(q.clicks, 10) || 0,
        impressions: parseInt(q.impressions, 10) || 0,
        ctr: parseFloat(q.ctr) || 0,
        position: parseFloat(q.position) || 0,
      })),
    };
  });
}

// =========================================================================
// 測定比較ロジック（Phase: Measure）
// =========================================================================

function loadSnapshot(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * 変更前後スナップショットを比較し、差分レポートを生成する。
 * 各ページのクリック・インプレッション・CTR・掲載順位の変化を計算する。
 */
function compareSnapshots(before, after) {
  const beforeMap = new Map(before.pages.map(p => [p.url, p]));
  const afterPages = after.pages || [];

  return afterPages.map(afterP => {
    const beforeP = beforeMap.get(afterP.url);
    if (!beforeP) {
      return { url: afterP.url, status: 'new', after: afterP, before: null, diff: null };
    }
    const diff = {
      clicks: afterP.clicks - beforeP.clicks,
      impressions: afterP.impressions - beforeP.impressions,
      ctr: afterP.ctr - beforeP.ctr,
      position: beforeP.position - afterP.position, // 負=順位下落（改善）
    };
    const pctChange = (field) => {
      const bVal = beforeP[field] || 0;
      return bVal > 0 ? Math.round(((afterP[field] - bVal) / bVal) * 100) : null;
    };
    return {
      url: afterP.url,
      status: 'measured',
      before: beforeP,
      after: afterP,
      diff,
      pctClicks: pctChange('clicks'),
      pctImpressions: pctChange('impressions'),
      weeksElapsed: before.timestamp && after.timestamp
        ? Math.round((new Date(after.timestamp) - new Date(before.timestamp)) / (7 * 86400000))
        : null,
    };
  });
}

// =========================================================================
// AI引用追跡（Phase: Track AI Citations）
// =========================================================================

/**
 * AI回答引用を追跡するためのテンプレートを生成する。
 * 実際の引用確認は手動またはAI Overview検証ツールで行う。
 */
function generateAiCitationTracker(domain, queries) {
  const items = queries.map(q => ({
    query: q.trim(),
    domain,
    trackedDate: new Date().toISOString().split('T')[0],
    status: '未確認', // '確認済' | '引用あり' | '引用なし' | '未確認'
    sourceAi: '',     // 'ChatGPT' | 'Perplexity' | 'Gemini' | 'Copilot'
    citationUrl: '',
    position: '',
    notes: '',
  }));
  return items;
}

// =========================================================================
// レポート生成
// =========================================================================

function generatePlanReport(selectedPages, keywords, config = {}) {
  const lines = [];
  lines.push('# SEO少数ページテスト計画（X-0049）');
  lines.push('');
  lines.push(`生成日: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push('## 概要');
  lines.push('');
  lines.push('Search Consoleの実データに基づき、3〜5ページにSEOスキルを適用し、');
  lines.push('2〜4週間の前後比較を実施する。本計画は GSC CSV エクスポート（手動）データをもとに策定。');
  lines.push('');
  if (keywords) {
    lines.push(`**対象キーワード**: ${keywords}`);
    lines.push('');
  }
  lines.push('## 選定ページ一覧');
  lines.push('');
  lines.push('| # | URL | クリック | インプレッション | CTR | 掲載順位 |');
  lines.push('|---|---|---|---|---|---|');
  selectedPages.forEach((p, i) => {
    lines.push(`| ${i + 1} | \`${p.url}\` | ${p.clicks} | ${p.impressions} | ${p.ctr.toFixed(2)}% | ${p.position.toFixed(1)} |`);
  });
  lines.push('');
  lines.push('## 各ページの流入クエリ上位');
  lines.push('');
  selectedPages.forEach((p, i) => {
    lines.push(`### ${i + 1}. ${p.url}`);
    lines.push('');
    if (p.pageQueries.length > 0) {
      lines.push('| クエリ | クリック | インプレッション | CTR | 掲載順位 |');
      lines.push('|---|---|---|---|---|');
      p.pageQueries.forEach(q => {
        lines.push(`| ${q.query} | ${q.clicks} | ${q.impressions} | ${q.ctr.toFixed(2)}% | ${q.position.toFixed(1)} |`);
      });
    } else {
      lines.push('（クエリデータなし）');
    }
    lines.push('');
  });
  lines.push('## テスト手順');
  lines.push('');
  lines.push('1. 本計画のページに対し SEO スキル（seo-title-optimization 等）を適用');
  lines.push('2. 適用前に GSC データのスナップショット（before.json）を保存');
  lines.push('3. 2〜4週間待機（この間、同一ページへの追加変更禁止）');
  lines.push('4. 再度 GSC データをエクスポートし（after.json）を保存');
  lines.push('5. 比較レポートを生成: `node tools/seo-small-page-test.mjs measure`');
  lines.push('');
  if (config.backlinkWarning !== false) {
    lines.push('## ⚠️ バックリンク購入に関する注意');
    lines.push('');
    lines.push('ターミナルからのバックリンク購入は Google ウェブマスタースパムポリシーに抵触する可能性がある。');
    lines.push('購入リンク（有料リンク・広告リンク等）は nofollow または sponsored 属性を付与すること。');
    lines.push('本テストでは有料バックリンク購入を行わず、自然な内部リンク改善のみで進めることを推奨。');
    lines.push('');
  }
  if (config.trackAiCitations !== false) {
    lines.push('## AI回答引用の追跡');
    lines.push('');
    lines.push('AI Overview / ChatGPT / Perplexity 等での自社サイト引用状況を別途追跡する。');
    lines.push('```bash');
    lines.push(`node tools/seo-small-page-test.mjs track-ai-citations \\`);
    lines.push(`  --domain "${config.domain || '<your-domain>'}" \\`);
    lines.push(`  --queries "${keywords || '<keywords>'}" \\`);
    lines.push('  --output seo/reports/ai-citations-YYYYMMDD.md');
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function generateComparisonReport(comparisons) {
  const lines = [];
  lines.push('# SEOスキル導入 前後比較レポート');
  lines.push('');
  lines.push(`生成日: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push('## サマリ');
  lines.push('');
  const measured = comparisons.filter(c => c.status === 'measured');
  const improvedClicks = measured.filter(c => c.diff && c.diff.clicks > 0);
  const improvedCtr = measured.filter(c => c.diff && c.diff.ctr > 0);
  const improvedPosition = measured.filter(c => c.diff && c.diff.position > 0);
  lines.push(`- 測定ページ数: ${measured.length}`);
  lines.push(`- クリック増加: ${improvedClicks.length}/${measured.length}`);
  lines.push(`- CTR向上: ${improvedCtr.length}/${measured.length}`);
  lines.push(`- 掲載順位改善: ${improvedPosition.length}/${measured.length}`);
  if (measured.length > 0) {
    const totalClicksBefore = measured.reduce((s, c) => s + (c.before?.clicks || 0), 0);
    const totalClicksAfter = measured.reduce((s, c) => s + (c.after?.clicks || 0), 0);
    lines.push(`- 総クリック: ${totalClicksBefore} → ${totalClicksAfter} (${totalClicksBefore > 0 ? `${Math.round((totalClicksAfter - totalClicksBefore) / totalClicksBefore * 100)}%` : 'N/A'})`);
  }
  lines.push('');
  lines.push('## ページ別比較');
  lines.push('');
  comparisons.forEach(c => {
    if (c.status === 'new') {
      lines.push(`### 新規: ${c.url}`);
      lines.push('（変更前データなし）');
      lines.push('');
      return;
    }
    lines.push(`### ${c.url}`);
    lines.push('');
    lines.push(`期間: ${c.weeksElapsed !== null ? `約${c.weeksElapsed}週間` : '不明'}`);
    lines.push('');
    lines.push('| 指標 | 変更前 | 変更後 | 差分 | 変化率 |');
    lines.push('|---|---|---|---|---|');
    lines.push(`| クリック | ${c.before.clicks} | ${c.after.clicks} | ${c.diff.clicks > 0 ? '+' : ''}${c.diff.clicks} | ${c.pctClicks !== null ? `${c.pctClicks > 0 ? '+' : ''}${c.pctClicks}%` : 'N/A'} |`);
    lines.push(`| インプレッション | ${c.before.impressions} | ${c.after.impressions} | ${c.diff.impressions > 0 ? '+' : ''}${c.diff.impressions} | ${c.pctImpressions !== null ? `${c.pctImpressions > 0 ? '+' : ''}${c.pctImpressions}%` : 'N/A'} |`);
    lines.push(`| CTR | ${c.before.ctr.toFixed(2)}% | ${c.after.ctr.toFixed(2)}% | ${c.diff.ctr > 0 ? '+' : ''}${c.diff.ctr.toFixed(2)}% | — |`);
    lines.push(`| 掲載順位 | ${c.before.position.toFixed(1)} | ${c.after.position.toFixed(1)} | ${c.diff.position > 0 ? '+' : ''}${c.diff.position.toFixed(1)} | — |`);
    lines.push('');
  });
  return lines.join('\n');
}

function generateAiCitationReport(items) {
  const lines = [];
  lines.push('# AI回答引用 追跡レポート');
  lines.push('');
  lines.push(`生成日: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');
  lines.push('## 追跡クエリ一覧');
  lines.push('');
  lines.push('| クエリ | 確認日 | ステータス | AI種別 | 引用URL | 備考 |');
  lines.push('|---|---|---|---|---|---|');
  items.forEach(item => {
    lines.push(`| ${item.query} | ${item.trackedDate} | ${item.status} | ${item.sourceAi} | ${item.citationUrl} | ${item.notes} |`);
  });
  lines.push('');
  lines.push('## 確認方法');
  lines.push('');
  lines.push('各クエリを以下のAI検索エンジンで手動検索し、自社サイトが引用されているか確認する:');
  lines.push('- ChatGPT Search (chatgpt.com)');
  lines.push('- Perplexity (perplexity.ai)');
  lines.push('- Google AI Overview (google.co.jp)');
  lines.push('- Gemini (gemini.google.com)');
  lines.push('- Copilot (copilot.microsoft.com)');
  lines.push('');
  return lines.join('\n');
}

// =========================================================================
// モックデータ
// =========================================================================

function makeMockPages() {
  return {
    pages: [
      { url: 'https://orgiast.jp/booth/construction', clicks: 45, impressions: 2340, ctr: 1.92, position: 8.5 },
      { url: 'https://orgiast.jp/booth/small-scale', clicks: 32, impressions: 1890, ctr: 1.69, position: 12.3 },
      { url: 'https://orgiast.jp/event/planning', clicks: 28, impressions: 1560, ctr: 1.79, position: 15.1 },
      { url: 'https://orgiast.jp/booth/cost-guide', clicks: 67, impressions: 3420, ctr: 1.96, position: 6.8 },
      { url: 'https://orgiast.jp/event/promotion', clicks: 15, impressions: 890, ctr: 1.69, position: 18.4 },
    ],
    timestamp: '2026-10-01T00:00:00Z',
    source: 'mock',
  };
}

function makeMockAfterPages() {
  return {
    pages: [
      { url: 'https://orgiast.jp/booth/construction', clicks: 58, impressions: 2510, ctr: 2.31, position: 7.2 },
      { url: 'https://orgiast.jp/booth/small-scale', clicks: 41, impressions: 2100, ctr: 1.95, position: 10.8 },
      { url: 'https://orgiast.jp/event/planning', clicks: 34, impressions: 1620, ctr: 2.10, position: 13.5 },
      { url: 'https://orgiast.jp/booth/cost-guide', clicks: 72, impressions: 3580, ctr: 2.01, position: 6.5 },
      { url: 'https://orgiast.jp/event/promotion', clicks: 19, impressions: 940, ctr: 2.02, position: 16.8 },
    ],
    timestamp: '2026-10-28T00:00:00Z',
    source: 'mock',
  };
}

function makeMockQueries() {
  return [
    { query: '展示会 ブース 費用', clicks: 67, impressions: 3420, ctr: 1.96, position: 6.8 },
    { query: '小規模ブース デザイン', clicks: 32, impressions: 1890, ctr: 1.69, position: 12.3 },
    { query: '展示会 集客 施策', clicks: 28, impressions: 1560, ctr: 1.79, position: 15.1 },
    { query: 'イベント 企画 代行', clicks: 15, impressions: 890, ctr: 1.69, position: 18.4 },
    { query: 'ブース製作 費用 相場', clicks: 45, impressions: 2340, ctr: 1.92, position: 8.5 },
    { query: 'ブース レンタル', clicks: 12, impressions: 670, ctr: 1.79, position: 22.3 },
  ];
}

// =========================================================================
// CLIメイン
// =========================================================================

function help() {
  console.log(`
SEO少数ページテスト手順（X-0049）測定ツール

使い方:
  plan            テスト計画を作成（GSC CSVから3〜5ページ選定）
  measure         変更前後のスナップショットを比較
  track-ai-citations  AI回答引用追跡テンプレート生成
  mock-plan       モックデータで計画テスト
  mock-report     モックデータで比較レポートテスト

オプション:
  --gsc-pages <file>    GSC Pages.csv のパス
  --gsc-queries <file>  GSC Queries.csv のパス
  --keywords "<kw>"     カンマ区切りキーワード
  --before <file>       変更前スナップショット (JSON)
  --after <file>        変更後スナップショット (JSON)
  --domain <url>        追跡対象ドメイン
  --queries "<q>"       追跡対象クエリ (カンマ区切り)
  --output <file>       出力ファイルパス
  --json                JSON形式で出力
  --no-backlink-warning バックリンク注意事項を省略
  --no-ai-tracking      AI引用追跡セクションを省略
  --help                このヘルプ
`);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find(a => !a.startsWith('--')) || 'help';

  const getFlag = (name) => {
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);
  const config = {
    backlinkWarning: !hasFlag('--no-backlink-warning'),
    trackAiCitations: !hasFlag('--no-ai-tracking'),
    domain: getFlag('--domain'),
  };

  const gscPagesFile = getFlag('--gsc-pages');
  const gscQueriesFile = getFlag('--gsc-queries');
  const keywords = getFlag('--keywords');
  const outputFile = getFlag('--output');
  const asJson = hasFlag('--json');

  switch (mode) {
    case 'plan': {
      if (!gscPagesFile) { console.error('--gsc-pages required'); process.exit(1); }
      if (!gscQueriesFile) { console.error('--gsc-queries required'); process.exit(1); }
      if (!keywords) { console.error('--keywords required'); process.exit(1); }
      const pages = parseGscPagesCsv(gscPagesFile);
      const queries = parseGscQueriesCsv(gscQueriesFile);
      const selected = selectTestPages(pages, queries, keywords);
      if (asJson) {
        console.log(JSON.stringify({ pages: selected, keywords, generatedAt: new Date().toISOString() }, null, 2));
      } else {
        const report = generatePlanReport(selected, keywords, { ...config, domain: config.domain || 'orgiast.jp' });
        if (outputFile) {
          fs.mkdirSync(path.dirname(outputFile), { recursive: true });
          fs.writeFileSync(outputFile, report, 'utf-8');
          console.log(`計画を出力しました: ${outputFile}`);
        } else {
          console.log(report);
        }
      }
      break;
    }
    case 'measure': {
      const beforeFile = getFlag('--before');
      const afterFile = getFlag('--after');
      if (!beforeFile || !afterFile) { console.error('--before and --after required'); process.exit(1); }
      const before = loadSnapshot(beforeFile);
      const after = loadSnapshot(afterFile);
      const comparisons = compareSnapshots(before, after);
      if (asJson) {
        console.log(JSON.stringify({ comparisons, generatedAt: new Date().toISOString() }, null, 2));
      } else {
        const report = generateComparisonReport(comparisons);
        if (outputFile) {
          fs.mkdirSync(path.dirname(outputFile), { recursive: true });
          fs.writeFileSync(outputFile, report, 'utf-8');
          console.log(`レポートを出力しました: ${outputFile}`);
        } else {
          console.log(report);
        }
      }
      break;
    }
    case 'track-ai-citations': {
      const domain = getFlag('--domain') || config.domain;
      const rawQueries = getFlag('--queries');
      if (!domain || !rawQueries) { console.error('--domain and --queries required'); process.exit(1); }
      const queries = rawQueries.split(',').map(q => q.trim());
      const items = generateAiCitationTracker(domain, queries);
      if (asJson) {
        console.log(JSON.stringify({ citations: items, generatedAt: new Date().toISOString() }, null, 2));
      } else {
        const report = generateAiCitationReport(items);
        if (outputFile) {
          fs.mkdirSync(path.dirname(outputFile), { recursive: true });
          fs.writeFileSync(outputFile, report, 'utf-8');
          console.log(`引用追跡テンプレートを出力しました: ${outputFile}`);
        } else {
          console.log(report);
        }
      }
      break;
    }
    case 'mock-plan': {
      const pages = makeMockPages();
      const queries = makeMockQueries();
      const jsonPages = pages.pages.map(p => ({
        url: p.url, clicks: String(p.clicks), impressions: String(p.impressions),
        ctr: String(p.ctr), position: String(p.position),
      }));
      const selected = selectTestPages(jsonPages, queries, '展示会,ブース,イベント');
      const report = generatePlanReport(selected, '展示会,ブース,イベント,小規模', { ...config, domain: 'orgiast.jp' });
      if (outputFile) {
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, report, 'utf-8');
        console.log(`モック計画を出力しました: ${outputFile}`);
      } else {
        console.log(report);
      }
      break;
    }
    case 'mock-report': {
      const before = makeMockPages();
      const after = makeMockAfterPages();
      const comparisons = compareSnapshots(before, after);
      const report = generateComparisonReport(comparisons);
      if (outputFile) {
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, report, 'utf-8');
        console.log(`モックレポートを出力しました: ${outputFile}`);
      } else {
        console.log(report);
      }
      break;
    }
    default:
      help();
      process.exit(0);
  }
}

if (isEntry(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}

export {
  parseCsv,
  csvRowsToObjects,
  selectTestPages,
  compareSnapshots,
  generatePlanReport,
  generateComparisonReport,
  generateAiCitationReport,
  generateAiCitationTracker,
  makeMockPages,
  makeMockAfterPages,
};