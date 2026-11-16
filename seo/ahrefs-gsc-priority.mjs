#!/usr/bin/env node
/**
 * ahrefs-gsc-priority.mjs — Ahrefs監査 × GSCデータ → AI優先度判定
 * X-0024: Ahrefs監査をAIで優先修正
 *
 * Ahrefsのクロールエラー一覧とGoogle Search Consoleのページデータを結合し、
 * エラーの重大性・流入影響・影響範囲から修正優先度を自動判定する。
 *
 * 使い方:
 *   node seo/ahrefs-gsc-priority.mjs --ahrefs <csv> --gsc <csv> [--output <file>]
 *   node seo/ahrefs-gsc-priority.mjs --mock                    # モックデータでテスト
 *   node seo/ahrefs-gsc-priority.mjs --mock --output report.md
 *   node seo/ahrefs-gsc-priority.mjs --mock --json             # JSON形式で出力
 *
 * Ahrefs CSV 想定列:
 *   URL, Error Type, Error Description, Affected Pages, First Detected, Last Detected, HTTP Status, Source
 *
 * GSC CSV 想定列:
 *   URL, Clicks, Impressions, CTR, Position, Queries
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../tools/is-entry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================================
// 設定
// =========================================================================

const CONFIG = {
  // エラー種別ごとの重大性スコア（1-10, 10=最重大）
  severityScores: {
    '404':           8,  // 消失ページ：ユーザー・クローラー共に損失大
    '410':           8,  // 同上
    '5xx':           9,  // サーバーエラー：クロール効率・UX直撃
    '500':           9,
    '502':           9,
    '503':           9,
    'redirect_chain': 6,  // リダイレクトチェーン：PageRank流出
    'redirect_loop':  9,  // リダイレクトループ：到達不能
    'broken_link_internal':  5,  // 内部リンク切れ：被リンク価値喪失
    'broken_link_external':  3,  // 外部リンク切れ：UX低下
    'missing_meta_description': 4,  // メタ記述欠落：CTR機会損失
    'missing_title':      9,  // タイトル欠落：SEO致命的
    'duplicate_title':    7,  // タイトル重複：IE最適化不全
    'missing_h1':         5,  // H1欠落：コンテンツ構造不全
    'multiple_h1':        3,  // H1重複：軽微
    'slow_page':          6,  // 低速ページ：Core Web Vitals
    'thin_content':       7,  // 薄いコンテンツ：品質評価低下
    'orphan_page':        6,  // 孤立ページ：クロール到達不能
    'no_internal_links':  6,  // 内部リンク無し：Indexing不全
    'soft_404':           8,  // ソフト404：誤認識
    'canonical_issue':    5,  // 正規URL問題：重複ペナルティ
    'https_mixed':        4,  // 混合コンテンツ：HTTPS評価に影響
    'blocked_by_robots':  7,  // robots.txtブロック：クロール不可
    'noindex_with_indexed': 8, // noindexありだがIndexed：矛盾
  },
  // 流入影響の重み（GSC）
  trafficWeights: {
    clicks: 0.5,
    impressions: 0.3,
    position: 0.2,
  },
  // 影響範囲の重み（Affected Pages）
  scopeWeights: {
    single: 1.0,    // 1ページ
    few: 1.5,       // 2-5ページ
    many: 2.0,      // 6-20ページ
    mass: 3.0,      // 21ページ以上
  },
  // 出力モード
  topN: 50,         // 上位何件を出力するか
};

// =========================================================================
// Ahrefs CSV パーサ
// =========================================================================

function parseAhrefsCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const urlIdx = headerIndex(headers, ['url', 'URL', 'url', 'page url', 'Target URL', 'target', 'address']);
  const typeIdx = headerIndex(headers, ['error type', 'Error Type', 'error_type', 'type', 'issue', 'Issue', 'issue_type', 'severity']);
  const descIdx = headerIndex(headers, ['error description', 'Error Description', 'description', 'issue detail', 'reason', 'Error', 'error']);
  const affectedIdx = headerIndex(headers, ['affected pages', 'Affected Pages', 'affected_pages', 'affected urls', 'links count', 'links', 'ref domains', 'Referring Domains', 'referring_domains']);
  const firstIdx = headerIndex(headers, ['first detected', 'First Detected', 'first_detected', 'first seen', 'first_seen']);
  const lastIdx = headerIndex(headers, ['last detected', 'Last Detected', 'last_detected', 'last seen', 'last_seen']);
  const statusIdx = headerIndex(headers, ['http status', 'HTTP Status', 'http_status', 'status code', 'status', 'Status Code']);
  const sourceIdx = headerIndex(headers, ['source', 'Source', 'link source', 'found in', 'found_on']);

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const record = {
      url: urlIdx >= 0 ? cols[urlIdx].trim() : '',
      errorType: classifyError(typeIdx >= 0 ? cols[typeIdx].trim() : '', statusIdx >= 0 ? cols[statusIdx].trim() : ''),
      errorDescription: descIdx >= 0 ? cols[descIdx].trim() : '',
      affectedPages: affectedIdx >= 0 ? parseInt(cols[affectedIdx].replace(/[^0-9]/g, ''), 10) || 1 : 1,
      firstDetected: firstIdx >= 0 ? cols[firstIdx].trim() : '',
      lastDetected: lastIdx >= 0 ? cols[lastIdx].trim() : '',
      httpStatus: statusIdx >= 0 ? cols[statusIdx].trim() : '',
      source: sourceIdx >= 0 ? cols[sourceIdx].trim() : '',
      originalType: typeIdx >= 0 ? cols[typeIdx].trim() : '',
    };
    if (record.url) records.push(record);
  }
  return records;
}

/** ヘッダー行から指定列名のインデックスを検索 */
function headerIndex(headers, candidates) {
  const h = headers.map(h => h.trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = h.indexOf(candidate.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

/** 簡易CSV行パーサ（カンマ区切り、クォート対応） */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/** Ahrefsのエラー種別を内部キーに分類 */
function classifyError(rawType, rawStatus) {
  const t = rawType.toLowerCase().trim();
  const s = rawStatus.trim();

  // HTTPステータスコード優先
  if (s.startsWith('404')) return '404';
  if (s.startsWith('410')) return '410';
  if (s.startsWith('500') || s.startsWith('502') || s.startsWith('503')) return '5xx';

  if (t.includes('redirect') && t.includes('loop')) return 'redirect_loop';
  if (t.includes('redirect') && t.includes('chain')) return 'redirect_chain';
  if (t.includes('redirect')) return 'redirect_chain';
  if (t.includes('broken') || t.includes('dead') && t.includes('internal')) return 'broken_link_internal';
  if (t.includes('broken') || t.includes('dead')) return 'broken_link_external';
  if (t.includes('meta description') || t.includes('meta desc')) return 'missing_meta_description';
  if (t.includes('missing title') || (t.includes('title') && t.includes('missing'))) return 'missing_title';
  if (t.includes('duplicate title') || (t.includes('title') && t.includes('duplicate'))) return 'duplicate_title';
  if (t.includes('missing h1') || (t.includes('h1') && t.includes('missing'))) return 'missing_h1';
  if ((t.includes('h1') || t.includes('heading')) && t.includes('multiple')) return 'multiple_h1';
  if (t.includes('slow') || t.includes('speed') || t.includes('lighthouse')) return 'slow_page';
  if (t.includes('thin') || t.includes('low content') || t.includes('short')) return 'thin_content';
  if (t.includes('orphan')) return 'orphan_page';
  if (t.includes('no internal') || t.includes('without internal')) return 'no_internal_links';
  if (t.includes('soft 404')) return 'soft_404';
  if (t.includes('canonical')) return 'canonical_issue';
  if (t.includes('mixed content') || t.includes('https')) return 'https_mixed';
  if (t.includes('robots') || t.includes('blocked')) return 'blocked_by_robots';
  if (t.includes('noindex')) return 'noindex_with_indexed';

  // 不明な種別は保持しつつデフォルト
  return `unknown:${rawType}`;
}

// =========================================================================
// GSC CSV パーサ
// =========================================================================

function parseGSCCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const urlIdx = headerIndex(headers, ['url', 'URL', 'page', 'Page', 'page url', 'address']);
  const clicksIdx = headerIndex(headers, ['clicks', 'Clicks', 'click', 'total clicks']);
  const impressionsIdx = headerIndex(headers, ['impressions', 'Impressions', 'impression', 'total impressions', 'imp']);
  const ctrIdx = headerIndex(headers, ['ctr', 'CTR', 'click through rate', 'clickthrough']);
  const posIdx = headerIndex(headers, ['position', 'Position', 'avg position', 'avg_position', 'pos', 'avg. position']);

  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const record = {
      url: urlIdx >= 0 ? cols[urlIdx].trim() : '',
      clicks: clicksIdx >= 0 ? parseInt(cols[clicksIdx].replace(/[^0-9.]/g, ''), 10) || 0 : 0,
      impressions: impressionsIdx >= 0 ? parseInt(cols[impressionsIdx].replace(/[^0-9.]/g, ''), 10) || 0 : 0,
      ctr: ctrIdx >= 0 ? parseFloat(cols[ctrIdx].replace(/[^0-9.]/g, '')) || 0 : 0,
      position: posIdx >= 0 ? parseFloat(cols[posIdx].replace(/[^0-9.]/g, '')) || 99 : 99,
    };
    if (record.url) records.push(record);
  }
  return records;
}

// =========================================================================
// URL正規化（統合用）
// =========================================================================

function normalizeURL(raw) {
  let url = raw.trim();
  // プロトコル除去
  url = url.replace(/^https?:\/\//i, '');
  // www除去
  url = url.replace(/^www\./i, '');
  // 末尾スラッシュ除去
  url = url.replace(/\/$/, '');
  // クエリ除去（優先度判定の粒度としてはパスまででよい）
  url = url.split('?')[0];
  // フラグメント除去
  url = url.split('#')[0];
  // 小文字化
  url = url.toLowerCase();
  // インデックスページ正規化
  url = url.replace(/\/index$/, '');
  url = url.replace(/\/default$/, '');
  // 日本語パスデコード（必要なら）
  try { url = decodeURIComponent(url); } catch { /* そのまま */ }
  return url;
}

// =========================================================================
// 優先度スコアリング
// =========================================================================

export function calculatePriority(errorRecord, gscData) {
  const normURL = normalizeURL(errorRecord.url);
  const gsc = gscData.find(g => normalizeURL(g.url) === normURL) || { clicks: 0, impressions: 0, position: 99, ctr: 0 };

  // 1) 重大性スコア (0-10)
  const severity = CONFIG.severityScores[errorRecord.errorType] || CONFIG.severityScores[`unknown:${errorRecord.errorType}`] || 5;

  // 2) 流入影響スコア (0-10)
  //    クリック数ベース: 0クリック=0, 100以上=10
  const clickScore = Math.min(gsc.clicks / 100, 1.0) * 10;
  //    表示回数ベース: 0表示=0, 10000以上=10
  const impressionScore = Math.min(gsc.impressions / 10000, 1.0) * 10;
  const trafficScore =
    clickScore * CONFIG.trafficWeights.clicks +
    impressionScore * CONFIG.trafficWeights.impressions;

  // 3) 影響範囲スコア (1-3)
  let scopeMultiplier;
  if (errorRecord.affectedPages <= 1) scopeMultiplier = CONFIG.scopeWeights.single;
  else if (errorRecord.affectedPages <= 5) scopeMultiplier = CONFIG.scopeWeights.few;
  else if (errorRecord.affectedPages <= 20) scopeMultiplier = CONFIG.scopeWeights.many;
  else scopeMultiplier = CONFIG.scopeWeights.mass;

  // 4) 総合スコア (0-100)
  //    severity 0-10 → 最大40点
  //    traffic  0-10 → 最大40点
  //    scope    1-3   → 最大20点
  const severityPoints = severity * 4;                 // 0-40
  const trafficPoints = trafficScore * 4;              // 0-40
  const scopePoints = (scopeMultiplier - 1) * 10;      // 0-20
  const finalScore = Math.min(severityPoints + trafficPoints + scopePoints, 100);

  // 5) 優先度ラベル
  let priorityLabel;
  if (finalScore >= 65) priorityLabel = 'P0-CRITICAL';
  else if (finalScore >= 45) priorityLabel = 'P1-HIGH';
  else if (finalScore >= 30) priorityLabel = 'P2-MEDIUM';
  else if (finalScore >= 15) priorityLabel = 'P3-LOW';
  else priorityLabel = 'P4-NEGLIGIBLE';

  return {
    url: errorRecord.url,
    normalizedURL: normURL,
    errorType: errorRecord.errorType,
    errorDescription: errorRecord.errorDescription,
    affectedPages: errorRecord.affectedPages,
    severityScore: severity,
    trafficScore: Math.round(trafficScore * 10) / 10,
    scopeMultiplier: scopeMultiplier,
    finalScore: Math.round(finalScore * 10) / 10,
    priority: priorityLabel,
    gscClicks: gsc.clicks,
    gscImpressions: gsc.impressions,
    gscPosition: gsc.position,
    reason: buildReason(errorRecord, severity, trafficScore, scopeMultiplier, gsc),
  };
}

function buildReason(errorRecord, severity, trafficScore, scopeMultiplier, gsc) {
  const parts = [];
  // 重大性
  if (severity >= 8) parts.push('致命的エラー（クローラー・UX直撃）');
  else if (severity >= 6) parts.push('重大なエラー');
  else if (severity >= 4) parts.push('中程度の問題');
  else parts.push('軽微な問題');

  // 流入影響
  if (gsc.clicks > 50) parts.push(`流入影響大（${gsc.clicks}クリック/月）`);
  else if (gsc.clicks > 10) parts.push(`流入影響あり（${gsc.clicks}クリック/月）`);
  else if (gsc.clicks > 0) parts.push(`流入影響小（${gsc.clicks}クリック/月）`);
  else if (gsc.impressions > 1000) parts.push(`表示は多いがクリック無し（${gsc.impressions}表示/月）→CTR改善余地`);
  else parts.push('GSCデータなし or 流入無し');

  // 影響範囲
  if (errorRecord.affectedPages > 20) parts.push(`${errorRecord.affectedPages}ページに影響（広範囲）`);
  else if (errorRecord.affectedPages > 5) parts.push(`${errorRecord.affectedPages}ページに影響`);
  else if (errorRecord.affectedPages > 1) parts.push(`${errorRecord.affectedPages}ページに影響`);
  // 1ページだけの場合は特に言及しない

  return parts.join('／');
}

// =========================================================================
// メインパイプライン
// =========================================================================

export function runPipeline(ahrefsRecords, gscRecords) {
  const scored = ahrefsRecords.map(r => calculatePriority(r, gscRecords));
  // スコア降順
  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

// =========================================================================
// レポート出力（Markdown）
// =========================================================================

function formatMarkdownReport(results, options) {
  const lines = [];

  const stats = {
    total: results.length,
    critical: results.filter(r => r.priority === 'P0-CRITICAL').length,
    high: results.filter(r => r.priority === 'P1-HIGH').length,
    medium: results.filter(r => r.priority === 'P2-MEDIUM').length,
    low: results.filter(r => r.priority === 'P3-LOW').length,
    negligible: results.filter(r => r.priority === 'P4-NEGLIGIBLE').length,
  };

  // サマリ
  lines.push(`# Ahrefs監査 × GSC 優先度判定レポート`);
  lines.push(``);
  lines.push(`生成日時: ${new Date().toISOString()}`);
  lines.push(`対象エラー数: ${stats.total}`);
  lines.push(``);
  lines.push(`## 優先度サマリ`);
  lines.push(``);
  lines.push(`| 優先度 | 件数 | 割合 |`);
  lines.push(`|--------|------|------|`);
  lines.push(`| P0-CRITICAL | ${stats.critical} | ${stats.total > 0 ? Math.round(stats.critical / stats.total * 100) : 0}% |`);
  lines.push(`| P1-HIGH | ${stats.high} | ${stats.total > 0 ? Math.round(stats.high / stats.total * 100) : 0}% |`);
  lines.push(`| P2-MEDIUM | ${stats.medium} | ${stats.total > 0 ? Math.round(stats.medium / stats.total * 100) : 0}% |`);
  lines.push(`| P3-LOW | ${stats.low} | ${stats.total > 0 ? Math.round(stats.low / stats.total * 100) : 0}% |`);
  lines.push(`| P4-NEGLIGIBLE | ${stats.negligible} | ${stats.total > 0 ? Math.round(stats.negligible / stats.total * 100) : 0}% |`);
  lines.push(``);

  // エラー種別サマリ
  const byType = {};
  for (const r of results) {
    byType[r.errorType] = (byType[r.errorType] || 0) + 1;
  }
  lines.push(`## エラー種別内訳（降順）`);
  lines.push(``);
  lines.push(`| エラー種別 | 件数 | 重大性 |`);
  lines.push(`|------------|------|--------|`);
  const sortedTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    const severity = CONFIG.severityScores[type] || 5;
    const severityLabel = severity >= 8 ? '🔴致命的' : severity >= 6 ? '🟠重大' : severity >= 4 ? '🟡中' : '🟢軽';
    const typeLabel = ERROR_TYPE_LABELS[type] || type;
    lines.push(`| ${typeLabel}(${type}) | ${count} | ${severityLabel}(${severity}) |`);
  }
  lines.push(``);

  // 優先度詳細一覧
  const displayResults = results.slice(0, options.topN || CONFIG.topN);
  lines.push(`## 修正優先度一覧（上位${displayResults.length}件）`);
  lines.push(``);
  lines.push(`| # | 優先度 | URL | エラー種別 | スコア | 流入(C/I) | 影響範囲 | 理由 |`);
  lines.push(`|---|--------|-----|------------|--------|----------|----------|------|`);
  for (let i = 0; i < displayResults.length; i++) {
    const r = displayResults[i];
    const priorityIcon = r.priority === 'P0-CRITICAL' ? '🔴' : r.priority === 'P1-HIGH' ? '🟠' : r.priority === 'P2-MEDIUM' ? '🟡' : '⚪';
    const trafficStr = `${r.gscClicks}/${r.gscImpressions}`;
    const shortURL = r.url.length > 60 ? r.url.slice(0, 57) + '...' : r.url;
    const errorLabel = ERROR_TYPE_LABELS[r.errorType] || r.errorType;
    lines.push(`| ${i+1} | ${priorityIcon}${r.priority} | ${shortURL} | ${errorLabel} | ${r.finalScore} | ${trafficStr} | ${r.affectedPages} | ${r.reason} |`);
  }
  lines.push(``);

  // P0一覧（別途まとめ）
  const critical = results.filter(r => r.priority === 'P0-CRITICAL');
  if (critical.length > 0) {
    lines.push(`## 🔴 P0-CRITICAL 一覧（即日対応推奨）`);
    lines.push(``);
    for (const r of critical) {
      lines.push(`- [ ] **${r.url}** — ${r.errorDescription || ERROR_TYPE_LABELS[r.errorType] || r.errorType}`);
      lines.push(`  - スコア: ${r.finalScore} | 流入: ${r.gscClicks}クリック/${r.gscImpressions}表示 | 影響: ${r.affectedPages}ページ`);
      lines.push(`  - 理由: ${r.reason}`);
      if (r.httpStatus) lines.push(`  - HTTP Status: ${r.httpStatus}`);
      lines.push(``);
    }
  }

  // P1一覧
  const high = results.filter(r => r.priority === 'P1-HIGH');
  if (high.length > 0) {
    lines.push(`## 🟠 P1-HIGH 一覧（週内対応推奨）`);
    lines.push(``);
    for (const r of high) {
      lines.push(`- [ ] **${r.url}** — ${r.errorDescription || ERROR_TYPE_LABELS[r.errorType] || r.errorType}`);
      lines.push(`  - スコア: ${r.finalScore} | 流入: ${r.gscClicks}クリック/${r.gscImpressions}表示 | 影響: ${r.affectedPages}ページ`);
      lines.push(`  - 理由: ${r.reason}`);
      lines.push(``);
    }
  }

  // アクションサマリ
  lines.push(`## 推奨アクション`);
  lines.push(``);
  lines.push(`1. **P0-CRITICAL（${stats.critical}件）**: 即日着手。エラーの種類に応じて404リダイレクト/復旧/削除→301。`);
  lines.push(`2. **P1-HIGH（${stats.high}件）**: 週内に対応。タイトル・メタ・H1の修正は即効性が高い。`);
  lines.push(`3. **P2-MEDIUM（${stats.medium}件）**: 月内に対応。孤立ページは内部リンク設置で改善。`);
  lines.push(`4. **P3-LOW / P4-NEGLIGIBLE（${stats.low + stats.negligible}件）**: 余力があれば対応。新規コンテンツ作成時のついでに。`);
  lines.push(``);
  lines.push(`---`);
  lines.push(`*Generated by X-0024 ahrefs-gsc-priority.mjs v1.0.0*`);

  return lines.join('\n');
}

// =========================================================================
// JSON 形式出力
// =========================================================================

function formatJSONReport(results, options) {
  const displayResults = results.slice(0, options.topN || CONFIG.topN);
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: results.length,
    stats: {
      critical: results.filter(r => r.priority === 'P0-CRITICAL').length,
      high: results.filter(r => r.priority === 'P1-HIGH').length,
      medium: results.filter(r => r.priority === 'P2-MEDIUM').length,
      low: results.filter(r => r.priority === 'P3-LOW').length,
      negligible: results.filter(r => r.priority === 'P4-NEGLIGIBLE').length,
    },
    results: displayResults,
  }, null, 2);
}

// =========================================================================
// エラー種別ラベル
// =========================================================================

const ERROR_TYPE_LABELS = {
  '404': '404 Not Found',
  '410': '410 Gone',
  '5xx': '5xx Server Error',
  'redirect_chain': 'リダイレクトチェーン',
  'redirect_loop': 'リダイレクトループ',
  'broken_link_internal': '内部リンク切れ',
  'broken_link_external': '外部リンク切れ',
  'missing_meta_description': 'メタ記述欠落',
  'missing_title': 'タイトル欠落',
  'duplicate_title': 'タイトル重複',
  'missing_h1': 'H1欠落',
  'multiple_h1': 'H1重複',
  'slow_page': '低速ページ',
  'thin_content': '薄いコンテンツ',
  'orphan_page': '孤立ページ',
  'no_internal_links': '内部リンク無し',
  'soft_404': 'ソフト404',
  'canonical_issue': '正規URL問題',
  'https_mixed': '混合コンテンツ',
  'blocked_by_robots': 'robots.txtブロック',
  'noindex_with_indexed': 'noindex矛盾',
};

// =========================================================================
// モックデータ生成（orgiast.jp 想定）
// =========================================================================

function generateMockAhrefs() {
  return [
    { url: 'https://www.orgiast.jp/case/hitachi-2025', errorType: '404', errorDescription: 'Page not found (404)', affectedPages: 3, firstDetected: '2026-09-15', lastDetected: '2026-11-10', httpStatus: '404', source: 'Internal Link' },
    { url: 'https://www.orgiast.jp/case/toshiba-2024', errorType: '404', errorDescription: 'Page not found (404)', affectedPages: 1, firstDetected: '2026-08-20', lastDetected: '2026-11-10', httpStatus: '404', source: 'External Link' },
    { url: 'https://www.orgiast.jp/event/seminar-ai-2025', errorType: '404', errorDescription: 'Page not found (404)', affectedPages: 2, firstDetected: '2026-10-01', lastDetected: '2026-11-10', httpStatus: '404', source: 'Sitemap' },
    { url: 'https://www.orgiast.jp/service/booth-construction', errorType: 'missing_title', errorDescription: 'Missing title tag', affectedPages: 1, firstDetected: '2026-10-15', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/service/event-planning', errorType: 'missing_meta_description', errorDescription: 'Missing meta description', affectedPages: 1, firstDetected: '2026-10-15', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/case/panasonic-2025', errorType: 'missing_h1', errorDescription: 'Missing H1 heading', affectedPages: 1, firstDetected: '2026-10-20', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/blog/', errorType: 'duplicate_title', errorDescription: 'Duplicate title tag (50+ pages share same title)', affectedPages: 52, firstDetected: '2026-09-01', lastDetected: '2026-11-10', httpStatus: '200', source: 'Site Audit' },
    { url: 'https://www.orgiast.jp/works/', errorType: 'missing_title', errorDescription: 'Missing title tag', affectedPages: 1, firstDetected: '2026-10-25', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/case/', errorType: 'slow_page', errorDescription: 'Slow page (3.2s load time)', affectedPages: 1, firstDetected: '2026-10-01', lastDetected: '2026-11-10', httpStatus: '200', source: 'Core Web Vitals' },
    { url: 'https://www.orgiast.jp/contact/', errorType: 'missing_meta_description', errorDescription: 'Missing meta description', affectedPages: 1, firstDetected: '2026-10-15', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/case/daikin-2024', errorType: 'orphan_page', errorDescription: 'Orphan page (no internal links)', affectedPages: 1, firstDetected: '2026-10-10', lastDetected: '2026-11-10', httpStatus: '200', source: 'Site Audit' },
    { url: 'https://www.orgiast.jp/service/', errorType: 'thin_content', errorDescription: 'Thin content (<300 words)', affectedPages: 1, firstDetected: '2026-09-20', lastDetected: '2026-11-10', httpStatus: '200', source: 'Content Audit' },
    { url: 'https://www.orgiast.jp/faq/', errorType: 'canonical_issue', errorDescription: 'Canonical URL points to different page', affectedPages: 1, firstDetected: '2026-10-05', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/case/nissan-2025', errorType: 'redirect_chain', errorDescription: 'Redirect chain (3 hops)', affectedPages: 1, firstDetected: '2026-10-12', lastDetected: '2026-11-10', httpStatus: '301', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/downloads/catalog-2025.pdf', errorType: '404', errorDescription: 'PDF not found', affectedPages: 1, firstDetected: '2026-09-10', lastDetected: '2026-11-10', httpStatus: '404', source: 'External Link' },
    { url: 'https://www.orgiast.jp/news/', errorType: 'missing_title', errorDescription: 'Missing title tag', affectedPages: 1, firstDetected: '2026-10-20', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/privacy/', errorType: 'no_internal_links', errorDescription: 'No internal links pointing to this page', affectedPages: 1, firstDetected: '2026-10-01', lastDetected: '2026-11-10', httpStatus: '200', source: 'Site Audit' },
    { url: 'https://www.orgiast.jp/case/mitsubishi-2025', errorType: 'soft_404', errorDescription: 'Returns 200 but content indicates 404', affectedPages: 1, firstDetected: '2026-10-15', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/images/old-logo.png', errorType: '404', errorDescription: 'Image not found', affectedPages: 5, firstDetected: '2026-08-01', lastDetected: '2026-11-10', httpStatus: '404', source: 'Internal Link' },
    { url: 'https://www.orgiast.jp/case/fujitsu-2026', errorType: 'missing_h1', errorDescription: 'Missing H1 heading', affectedPages: 1, firstDetected: '2026-10-25', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
    { url: 'https://www.orgiast.jp/blog/booth-design-tips-2025', errorType: 'noindex_with_indexed', errorDescription: 'noindex tag present but page is indexed', affectedPages: 1, firstDetected: '2026-10-20', lastDetected: '2026-11-10', httpStatus: '200', source: 'Site Audit' },
    { url: 'https://www.orgiast.jp/case-summary/', errorType: 'duplicate_title', errorDescription: 'Duplicate title with /case/', affectedPages: 2, firstDetected: '2026-10-10', lastDetected: '2026-11-10', httpStatus: '200', source: 'Crawl' },
  ];
}

function generateMockGSC() {
  // ページ別の検索パフォーマンス（簡易データ）
  const pages = [
    { url: 'https://www.orgiast.jp/case/',            clicks: 340, impressions: 12500, ctr: 2.72, position: 8.5 },
    { url: 'https://www.orgiast.jp/service/',         clicks: 280, impressions: 9800,  ctr: 2.86, position: 7.2 },
    { url: 'https://www.orgiast.jp/contact/',         clicks: 950, impressions: 4200,  ctr: 22.6, position: 3.1 },
    { url: 'https://www.orgiast.jp/blog/',            clicks: 120, impressions: 8500,  ctr: 1.41, position: 12.3 },
    { url: 'https://www.orgiast.jp/news/',            clicks: 45,  impressions: 3200,  ctr: 1.41, position: 11.8 },
    { url: 'https://www.orgiast.jp/faq/',             clicks: 210, impressions: 6400,  ctr: 3.28, position: 5.6 },
    { url: 'https://www.orgiast.jp/works/',           clicks: 89,  impressions: 4100,  ctr: 2.17, position: 9.4 },
    { url: 'https://www.orgiast.jp/privacy/',         clicks: 15,  impressions: 520,   ctr: 2.88, position: 4.2 },
    { url: 'https://www.orgiast.jp/service/booth-construction',   clicks: 195, impressions: 6100, ctr: 3.20, position: 6.8 },
    { url: 'https://www.orgiast.jp/service/event-planning',       clicks: 78,  impressions: 3400, ctr: 2.29, position: 9.1 },
    { url: 'https://www.orgiast.jp/case/nissan-2025',             clicks: 34,  impressions: 1200, ctr: 2.83, position: 7.5 },
    { url: 'https://www.orgiast.jp/case/panasonic-2025',          clicks: 42,  impressions: 2100, ctr: 2.00, position: 8.2 },
    { url: 'https://www.orgiast.jp/case/hitachi-2025',            clicks: 28,  impressions: 980,  ctr: 2.86, position: 7.9 },
    { url: 'https://www.orgiast.jp/case/daikin-2024',             clicks: 8,   impressions: 340,  ctr: 2.35, position: 10.4 },
    { url: 'https://www.orgiast.jp/case/mitsubishi-2025',         clicks: 15,  impressions: 670,  ctr: 2.24, position: 11.2 },
    { url: 'https://www.orgiast.jp/blog/booth-design-tips-2025',  clicks: 6,   impressions: 280,  ctr: 2.14, position: 14.5 },
    { url: 'https://www.orgiast.jp/downloads/catalog-2025.pdf',   clicks: 22,  impressions: 480,  ctr: 4.58, position: 5.1 },
  ];
  // エラーURLとマッチさせるためURLを揃える
  return pages.map(p => ({
    url: p.url,
    clicks: p.clicks,
    impressions: p.impressions,
    ctr: p.ctr,
    position: p.position,
  }));
}

// =========================================================================
// CLIエントリポイント
// =========================================================================

function parseArgs(argv) {
  const opts = {
    ahrefsFile: '',
    gscFile: '',
    output: '',
    mock: false,
    json: false,
    topN: CONFIG.topN,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ahrefs' && argv[i + 1]) opts.ahrefsFile = argv[++i];
    else if (arg === '--gsc' && argv[i + 1]) opts.gscFile = argv[++i];
    else if (arg === '--output' && argv[i + 1]) opts.output = argv[++i];
    else if (arg === '--top' && argv[i + 1]) opts.topN = parseInt(argv[++i], 10);
    else if (arg === '--mock') opts.mock = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    console.log(`ahrefs-gsc-priority.mjs — Ahrefs監査×GSCデータ優先度判定 v1.0.0

使い方:
  node seo/ahrefs-gsc-priority.mjs --ahrefs <csv> --gsc <csv> [options]
  node seo/ahrefs-gsc-priority.mjs --mock [options]

オプション:
  --ahrefs <file>   AhrefsエクスポートCSV
  --gsc <file>       Search ConsoleページデータCSV
  --output <file>    出力ファイル（省略時はstdout）
  --top <n>          上位N件を表示（既定: ${CONFIG.topN})
  --mock             モックデータで実行
  --json             JSON形式で出力
  --help / -h        このヘルプ

CSVフォーマット:
  Ahrefs: URL, Error Type, Error Description, Affected Pages, First Detected, Last Detected, HTTP Status, Source
  GSC:    URL, Clicks, Impressions, CTR, Position
`);
    process.exit(0);
  }

  // データ取得
  let ahrefsRecords, gscRecords;

  if (opts.mock) {
    console.error('[ahrefs-gsc-priority] モックモードで実行します');
    ahrefsRecords = generateMockAhrefs();
    gscRecords = generateMockGSC();
  } else if (opts.ahrefsFile && opts.gscFile) {
    if (!fs.existsSync(opts.ahrefsFile)) { console.error(`Ahrefsファイルが見つかりません: ${opts.ahrefsFile}`); process.exit(1); }
    if (!fs.existsSync(opts.gscFile))    { console.error(`GSCファイルが見つかりません: ${opts.gscFile}`); process.exit(1); }
    const ahrefsText = fs.readFileSync(opts.ahrefsFile, 'utf-8');
    const gscText = fs.readFileSync(opts.gscFile, 'utf-8');
    ahrefsRecords = parseAhrefsCSV(ahrefsText);
    gscRecords = parseGSCCSV(gscText);
  } else {
    console.error('Usage: --ahrefs <csv> --gsc <csv> または --mock');
    process.exit(2);
  }

  console.error(`[ahrefs-gsc-priority] Ahrefs: ${ahrefsRecords.length}件, GSC: ${gscRecords.length}件`);

  // パイプライン実行
  const results = runPipeline(ahrefsRecords, gscRecords);

  // 出力
  const output = opts.json
    ? formatJSONReport(results, opts)
    : formatMarkdownReport(results, opts);

  if (opts.output) {
    const outPath = path.resolve(opts.output);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, 'utf-8');
    console.log(`レポートを出力しました: ${outPath}`);
  } else {
    console.log(output);
  }
}

if (isEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}