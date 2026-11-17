#!/usr/bin/env node
/**
 * GSC バブルチャート可視化ツール
 * Google Search Console のクエリデータCSVから3ゾーンバブルチャートを生成する
 *
 * 使い方:
 *   node tools/gsc-bubble-chart.mjs --input queries.csv [--output chart.html] [--site "orgiast.jp"]
 *   node tools/gsc-bubble-chart.mjs --demo [--output chart.html]
 *
 * 入力CSV形式（Search Console エクスポート）:
 *   Query, Impressions, Clicks, Position, CTR
 *   または Pages.csv: Page, Impressions, Clicks, Position, CTR
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `使い方:
  node tools/gsc-bubble-chart.mjs --input <csv-path> [options]
  node tools/gsc-bubble-chart.mjs --demo [options]

オプション:
  --input <path>      Search Console エクスポートCSVへのパス
  --output <path>     出力HTMLパス（省略時: gsc-bubble-chart.html）
  --site <name>       サイト名（ヘッダー表示用）
  --demo              サンプルデータ（展示会・ブース関連クエリ50件）でHTML生成
  --min-impressions <n> 最小インプレッション数のフィルタ（省略時: 0）
  --help              このヘルプを表示
`;

// ─── サンプルデータ（展示会・ブース関連クエリ50件） ─────────────────────
function generateDemoData() {
  const queries = [
    // 赤ゾーン想定: 順位1〜10, CTR < 5%
    { query: '展示会 ブース 制作 会社', impressions: 3200, clicks: 48, position: 3.2, ctr: 1.5 },
    { query: 'イベント ブース デザイン', impressions: 2800, clicks: 35, position: 2.8, ctr: 1.25 },
    { query: '展示会 出展 ブース レンタル', impressions: 1500, clicks: 22, position: 4.5, ctr: 1.47 },
    { query: '企業 展示会 ブース 製作', impressions: 2100, clicks: 31, position: 5.1, ctr: 1.48 },
    { query: '展示会 ブース 施工', impressions: 1800, clicks: 39, position: 7.2, ctr: 2.17 },
    { query: 'ブース 制作 会社 東京', impressions: 950, clicks: 18, position: 6.8, ctr: 1.89 },
    { query: '展示会 小間 ブース デザイン', impressions: 1200, clicks: 15, position: 8.5, ctr: 1.25 },
    { query: 'イベント 展示 ブース 設計', impressions: 780, clicks: 11, position: 9.2, ctr: 1.41 },
    { query: '展示会 ブース 内装', impressions: 650, clicks: 8, position: 4.8, ctr: 1.23 },
    { query: 'ブース 装修 施工 会社', impressions: 520, clicks: 7, position: 7.5, ctr: 1.35 },
    // 黄ゾーン想定: 順位11〜20, または CTR 5〜15%
    { query: '展示会 ブース 事例', impressions: 4200, clicks: 380, position: 11.5, ctr: 9.05 },
    { query: 'ブース デザイン 事例 画像', impressions: 3500, clicks: 280, position: 12.3, ctr: 8.0 },
    { query: '展示会 出展 費用 相場', impressions: 2900, clicks: 210, position: 14.1, ctr: 7.24 },
    { query: '展示会 ブース 料金', impressions: 2600, clicks: 185, position: 15.8, ctr: 7.12 },
    { query: 'イベント ブース 製作 費用', impressions: 1900, clicks: 165, position: 16.2, ctr: 8.68 },
    { query: '展示会 小間 借りる', impressions: 1700, clicks: 145, position: 17.5, ctr: 8.53 },
    { query: 'ブース 装飾 デザイン 会社', impressions: 1400, clicks: 120, position: 18.1, ctr: 8.57 },
    { query: '展示 ブース 設計 施工 お願い', impressions: 1100, clicks: 88, position: 19.3, ctr: 8.0 },
    { query: '展示会 ブース レイアウト', impressions: 980, clicks: 75, position: 13.7, ctr: 7.65 },
    { query: '企業 展示会 小間 デザイン', impressions: 820, clicks: 62, position: 20.0, ctr: 7.56 },
    { query: '展示会 ブース 自作', impressions: 750, clicks: 55, position: 11.8, ctr: 7.33 },
    { query: 'ブース イベント 装飾 アイデア', impressions: 680, clicks: 48, position: 15.5, ctr: 7.06 },
    { query: '展示会 装飾 会社 おすすめ', impressions: 600, clicks: 42, position: 19.8, ctr: 7.0 },
    { query: '展示会 ブース 机 レンタル', impressions: 550, clicks: 52, position: 8.2, ctr: 9.45 },
    { query: '展示会 パネル 制作', impressions: 480, clicks: 38, position: 14.6, ctr: 7.92 },
    // 灰ゾーン想定: 順位21以下
    { query: '展示会 ブース カタログ 制作', impressions: 12000, clicks: 85, position: 28.5, ctr: 0.71 },
    { query: 'ブース 制作 流れ', impressions: 8500, clicks: 62, position: 25.2, ctr: 0.73 },
    { query: '展示会 スケジュール 準備', impressions: 6400, clicks: 45, position: 32.1, ctr: 0.70 },
    { query: '展示会 ブース 打ち合わせ', impressions: 5200, clicks: 38, position: 35.4, ctr: 0.73 },
    { query: 'イベント 出展 申込 方法', impressions: 4800, clicks: 32, position: 38.7, ctr: 0.67 },
    { query: '展示会 効果 測定', impressions: 3800, clicks: 28, position: 41.2, ctr: 0.74 },
    { query: '展示会 集客 方法', impressions: 3500, clicks: 25, position: 30.8, ctr: 0.71 },
    { query: '展示会 参加 費 補助金', impressions: 2800, clicks: 22, position: 33.6, ctr: 0.79 },
    { query: '展示会 来場者 アンケート', impressions: 2400, clicks: 18, position: 36.9, ctr: 0.75 },
    { query: 'BtoB 展示会 成功 事例', impressions: 2100, clicks: 16, position: 39.5, ctr: 0.76 },
    { query: '展示会 名刺 交換 コツ', impressions: 1850, clicks: 14, position: 42.1, ctr: 0.76 },
    { query: '展示会 アフター フォロー', impressions: 1600, clicks: 12, position: 44.3, ctr: 0.75 },
    { query: '展示会 スタッフ 教育', impressions: 1400, clicks: 10, position: 26.7, ctr: 0.71 },
    { query: '展示会 競合 調査', impressions: 1250, clicks: 9, position: 31.4, ctr: 0.72 },
    { query: '展示会 告知 方法 SNS', impressions: 1100, clicks: 8, position: 37.8, ctr: 0.73 },
    { query: '展示会 プレゼン 資料 作り方', impressions: 980, clicks: 7, position: 43.5, ctr: 0.71 },
    { query: '展示会 ブース ゲーム 企画', impressions: 850, clicks: 6, position: 29.1, ctr: 0.71 },
    { query: '展示会 ノベルティ 制作', impressions: 720, clicks: 5, position: 34.2, ctr: 0.69 },
    { query: '展示会 アンケート 景品', impressions: 650, clicks: 5, position: 40.7, ctr: 0.77 },
    { query: '展示会 写真 撮影 ルール', impressions: 580, clicks: 4, position: 45.6, ctr: 0.69 },
    { query: '展示会 配布物 リスト', impressions: 500, clicks: 4, position: 38.3, ctr: 0.8 },
    { query: '展示会 次回 出展 予定', impressions: 450, clicks: 3, position: 42.8, ctr: 0.67 },
    { query: '展示会 オンライン 併用', impressions: 400, clicks: 3, position: 46.1, ctr: 0.75 },
    { query: '展示会 予算 組み方', impressions: 380, clicks: 3, position: 35.6, ctr: 0.79 },
    { query: '展示会 社内 報告 書', impressions: 350, clicks: 2, position: 44.9, ctr: 0.57 },
  ];
  return queries;
}

// ─── CSV パース ─────────────────────────────────────────────────────────
export function parseCSV(text) {
  const records = parseCSVRecords(text.replace(/^\uFEFF/, ''));
  if (records.length < 2) throw new Error('CSVにデータ行がありません');

  const header = records[0];
  const colMap = {};
  const required = ['Query', 'Impressions', 'Clicks', 'Position', 'CTR'];
  const aliases = {
    'query': 'Query', 'queries': 'Query', 'keyword': 'Query', 'keywords': 'Query',
    'impressions': 'Impressions',
    'clicks': 'Clicks',
    'position': 'Position', 'avg position': 'Position', 'avg_position': 'Position',
    'ctr': 'CTR', 'ctr%': 'CTR',
    'page': 'Page', 'pages': 'Page', 'url': 'Page',
  };

  for (let i = 0; i < header.length; i++) {
    const raw = header[i].trim();
    const normalized = raw.replace(/"/g, '').trim();
    const mapped = aliases[normalized.toLowerCase()] || normalized;
    // 正規化名（先頭大文字）でマッチ
    const stdKey = required.find(r => r.toLowerCase() === mapped.toLowerCase());
    if (stdKey) {
      colMap[stdKey] = i;
    } else if (colMap.Query === undefined && (mapped === 'Page' || normalized.toLowerCase() === 'url')) {
      // Pages.csv でも以降の描画処理では共通の query フィールドを使う。
      colMap.Query = i;
    }
  }

  const missing = required.filter(r => colMap[r] === undefined);
  if (missing.length > 0) {
    throw new Error(`CSVに必須カラムが見つかりません: ${missing.join(', ')}\n見つかったカラム: ${header.join(', ')}`);
  }

  const rows = [];
  for (let i = 1; i < records.length; i++) {
    const vals = records[i];
    if (vals.length <= Math.max(...Object.values(colMap))) continue;
    try {
      const row = {
        query: vals[colMap['Query']].trim().replace(/^"(.*)"$/, '$1'),
        impressions: parseInt(vals[colMap['Impressions']].replace(/[,\s]/g, '')) || 0,
        clicks: parseInt(vals[colMap['Clicks']].replace(/[,\s]/g, '')) || 0,
        position: parseFloat(vals[colMap['Position']].replace(/[,\s]/g, '')) || 0,
        ctr: parseCTR(vals[colMap['CTR']]),
      };
      if (row.impressions > 0 && row.position > 0) rows.push(row);
    } catch { /* パース不能行はスキップ */ }
  }
  return rows;
}

export function parseCSVRecords(text) {
  const records = [];
  let record = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        record.push(current);
        current = '';
      } else if (ch === '\n' || ch === '\r') {
        record.push(current);
        records.push(record);
        record = [];
        current = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else {
        current += ch;
      }
    }
  }
  if (inQuotes) throw new Error('CSVの引用符が閉じられていません');
  if (current !== '' || record.length > 0) {
    record.push(current);
    records.push(record);
  }
  return records.filter(row => row.some(value => value.trim() !== ''));
}

function parseCTR(val) {
  val = val.trim().replace(/[,\s]/g, '');
  if (val.endsWith('%')) {
    return parseFloat(val.replace('%', '')) / 100;
  }
  const n = parseFloat(val);
  // CTR > 1 はパーセント値とみなす
  return n > 1 ? n / 100 : n;
}

// ─── ゾーン分類 ─────────────────────────────────────────────────────────
export function classifyZone(position, ctr) {
  if (position <= 10 && ctr < 0.05) return 'mismatch';
  if (position <= 20 || (ctr >= 0.05 && ctr < 0.15)) return 'potential';
  return 'assess';
}

// ─── HTML 生成 ──────────────────────────────────────────────────────────
export function generateHTML(data, { siteName = '', minImpressions = 0 } = {}) {
  const filtered = data.filter(r => r.impressions >= minImpressions);
  const sorted = [...filtered].sort((a, b) => a.position - b.position);

  // バブルが小さすぎ/大きすぎを防ぐスケーリング
  const maxClicks = Math.max(...sorted.map(r => r.clicks), 1);
  const bubbleScale = (c) => Math.max(5, Math.min(50, (c / maxClicks) * 40 + 5));

  // データ行をJavaScript配列に
  const dataJson = sorted.map(r => {
    const zone = classifyZone(r.position, r.ctr);
    return {
      q: r.query,
      i: r.impressions,
      c: r.clicks,
      p: Math.round(r.position * 10) / 10,
      ct: Math.round(r.ctr * 1000) / 10,
      z: zone,
      size: Math.round(bubbleScale(r.clicks) * 10) / 10,
    };
  });

  const siteLabel = siteName ? ` — ${escapeHTML(siteName)}` : '';
  const totalQueries = sorted.length;
  const totalImpressions = sorted.reduce((s, r) => s + r.impressions, 0);
  const totalClicks = sorted.reduce((s, r) => s + r.clicks, 0);
  const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0;

  const mismatchCount = sorted.filter(r => classifyZone(r.position, r.ctr) === 'mismatch').length;
  const potentialCount = sorted.filter(r => classifyZone(r.position, r.ctr) === 'potential').length;
  const assessCount = sorted.filter(r => classifyZone(r.position, r.ctr) === 'assess').length;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Search Console 3ゾーンバブルチャート${siteLabel}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; background: #f5f7fa; color: #222; padding: 20px; }
.container { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 1.4em; color: #333; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
h1 small { font-size: 0.6em; color: #888; }
.summary { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
.stat-card { background: #fff; border-radius: 10px; padding: 14px 18px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); flex: 1; min-width: 120px; text-align: center; }
.stat-card .num { font-size: 1.5em; font-weight: 700; color: #333; }
.stat-card .label { font-size: 0.78em; color: #888; margin-top: 4px; }
.legend-zones { display: flex; gap: 12px; margin: 12px 0 16px; flex-wrap: wrap; align-items: center; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 0.85em; padding: 4px 10px; border-radius: 6px; }
.legend-item .dot { width: 14px; height: 14px; border-radius: 50%; display: inline-block; }
.legend-item.mismatch .dot { background: #e74c3c; }
.legend-item.potential .dot { background: #f0ad4e; }
.legend-item.assess .dot { background: #95a5a6; }
.legend-item .count { color: #999; font-size: 0.85em; }
.chart-wrap { background: #fff; border-radius: 10px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 20px; position: relative; }
#chart { width: 100%; height: 600px; }
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.filters label { font-size: 0.85em; color: #555; }
.filters input[type="range"] { width: 200px; }
.filters .val { font-weight: 700; color: #333; }
.tooltip-data { display: none; position: fixed; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 10px 14px; box-shadow: 0 2px 12px rgba(0,0,0,0.15); z-index: 999; pointer-events: none; max-width: 360px; font-size: 0.88em; }
.tooltip-data .tt-query { font-weight: 600; color: #333; margin-bottom: 4px; }
.tooltip-data .tt-row { display: flex; justify-content: space-between; gap: 12px; }
.tooltip-data .tt-label { color: #888; }
.tooltip-data .tt-val { font-weight: 600; color: #333; }
footer { text-align: center; font-size: 0.75em; color: #aaa; margin-top: 20px; }
.zone-hint { font-size: 0.78em; color: #999; margin: 4px 0; }
</style>
</head>
<body>
<div class="container">
<h1>🔍 Search Console 3ゾーンバブルチャート<small>${siteLabel}</small></h1>

<div class="summary">
  <div class="stat-card"><div class="num">${totalQueries.toLocaleString()}</div><div class="label">クエリ数</div></div>
  <div class="stat-card"><div class="num">${totalImpressions.toLocaleString()}</div><div class="label">総インプレッション</div></div>
  <div class="stat-card"><div class="num">${totalClicks.toLocaleString()}</div><div class="label">総クリック</div></div>
  <div class="stat-card"><div class="num">${avgCTR.toFixed(1)}%</div><div class="label">平均CTR</div></div>
</div>

<div class="legend-zones">
  <span class="legend-item mismatch"><span class="dot"></span> 赤ゾーン（ミスマッチ）<span class="count">${mismatchCount}件</span></span>
  <span class="legend-item potential"><span class="dot"></span> 黄ゾーン（可能性）<span class="count">${potentialCount}件</span></span>
  <span class="legend-item assess"><span class="dot"></span> 灰ゾーン（見極め）<span class="count">${assessCount}件</span></span>
</div>

<div class="filters">
  <label>最小インプレッション: <span class="val" id="filterVal">0</span></label>
  <input type="range" id="minImpFilter" min="0" max="${Math.max(...sorted.map(r => r.impressions), 1000)}" value="0" step="100">
  <label style="margin-left:8px">表示件数: <span id="showCount">${sorted.length}</span>件</label>
</div>

<div class="chart-wrap">
  <canvas id="chart"></canvas>
</div>

<div class="zone-hint">
  🔴 赤ゾーン（順位1〜10, CTR&lt;5%）: タイトル・説明文の改善が必要 &nbsp;|&nbsp;
  🟡 黄ゾーン（順位11〜20 or CTR 5〜15%）: コンテンツ追加で改善可能 &nbsp;|&nbsp;
  ⚪ 灰ゾーン（順位21以下）: 記事の要否を判断
</div>
<footer>Generated by gsc-bubble-chart.mjs — データを更新するには再生成してください</footer>
</div>

<div id="tooltip" class="tooltip-data"></div>

<script>
const ALL_DATA = ${safeJsonForScript(dataJson)};

const ZONE_COLORS = {
  mismatch: { bg: 'rgba(231, 76, 60, 0.55)', border: 'rgba(231, 76, 60, 0.9)' },
  potential: { bg: 'rgba(240, 173, 78, 0.55)', border: 'rgba(240, 173, 78, 0.9)' },
  assess: { bg: 'rgba(149, 165, 166, 0.5)', border: 'rgba(149, 165, 166, 0.85)' },
};
const ZONE_LABELS = { mismatch: '赤ゾーン（ミスマッチ）', potential: '黄ゾーン（可能性）', assess: '灰ゾーン（見極め）' };
const ZONE_ORDER = { mismatch: 0, potential: 1, assess: 2 };

function filterData(minImp) {
  return ALL_DATA.filter(d => d.i >= minImp);
}

let currentChart = null;

function renderChart(minImp) {
  const data = filterData(minImp);
  // ゾーン別にグループ化
  const grouped = { mismatch: [], potential: [], assess: [] };
  for (const d of data) grouped[d.z].push(d);

  const datasets = [];
  for (const zone of ['mismatch', 'potential', 'assess']) {
    const items = grouped[zone];
    if (items.length === 0) continue;
    datasets.push({
      label: ZONE_LABELS[zone],
      data: items.map(d => ({
        x: d.p,
        y: d.i,
        r: d.size,
        raw: d,
      })),
      backgroundColor: ZONE_COLORS[zone].bg,
      borderColor: ZONE_COLORS[zone].border,
      borderWidth: 1,
      pointHitDetectionRadius: items.length < 30 ? 12 : 8,
    });
  }

  const ctx = document.getElementById('chart').getContext('2d');
  if (currentChart) currentChart.destroy();

  currentChart = new Chart(ctx, {
    type: 'bubble',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { padding: 14, usePointStyle: true, font: { size: 12 } } },
        tooltip: {
          enabled: false,
          external: {
            before: function(ctx) {
              const tip = document.getElementById('tooltip');
              if (ctx.tooltip.dataPoints.length === 0) { tip.style.display = 'none'; return; }
              const dp = ctx.tooltip.dataPoints[0];
              const r = dp.raw.raw;
              tip.innerHTML = '<div class="tt-query">' + esc(r.q) + '</div>'
                + '<div class="tt-row"><span class="tt-label">掲載順位</span><span class="tt-val">' + r.p + '位</span></div>'
                + '<div class="tt-row"><span class="tt-label">インプレッション</span><span class="tt-val">' + r.i.toLocaleString() + '</span></div>'
                + '<div class="tt-row"><span class="tt-label">クリック</span><span class="tt-val">' + r.c.toLocaleString() + '</span></div>'
                + '<div class="tt-row"><span class="tt-label">CTR</span><span class="tt-val">' + r.ct + '%</span></div>'
                + '<div class="tt-row"><span class="tt-label">ゾーン</span><span class="tt-val">' + ZONE_LABELS[r.z] + '</span></div>';
              tip.style.display = 'block';
              const canvasRect = document.getElementById('chart').getBoundingClientRect();
              let tx = ctx.tooltip.x + canvasRect.left + 12;
              let ty = ctx.tooltip.y + canvasRect.top - 10;
              if (tx + 370 > window.innerWidth) tx = ctx.tooltip.x + canvasRect.left - 370;
              if (ty < 10) ty = 10;
              if (ty + 180 > window.innerHeight) ty = window.innerHeight - 190;
              tip.style.left = tx + 'px';
              tip.style.top = ty + 'px';
            },
            after: function(ctx) {
              if (ctx.tooltip.dataPoints.length === 0) document.getElementById('tooltip').style.display = 'none';
            },
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: '掲載順位', font: { size: 13 } },
          min: 0.5,
          max: 51,
          reverse: true,
          ticks: { stepSize: 5, callback: v => v + '位' },
          grid: { color: 'rgba(0,0,0,0.06)' },
        },
        y: {
          title: { display: true, text: 'インプレッション数', font: { size: 13 } },
          type: 'logarithmic',
          ticks: {
            callback: v => {
              if (v >= 10000) return (v/10000).toFixed(0) + '万';
              if (v >= 1000) return (v/1000).toFixed(1) + 'k';
              return v;
            }
          },
          grid: { color: 'rgba(0,0,0,0.06)' },
        }
      },
      layout: { padding: { top: 20, right: 20, bottom: 10, left: 10 } },
    }
  });

  document.getElementById('showCount').textContent = data.length;
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const slider = document.getElementById('minImpFilter');
slider.addEventListener('input', function() {
  const v = parseInt(this.value);
  document.getElementById('filterVal').textContent = v.toLocaleString();
  renderChart(v);
});
renderChart(0);
</script>
</body>
</html>`;
}

function escapeHTML(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// ─── メイン ──────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  let inputPath = null;
  let outputPath = 'gsc-bubble-chart.html';
  let siteName = '';
  let isDemo = false;
  let minImpressions = 0;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':
        inputPath = args[++i];
        break;
      case '--output':
        outputPath = args[++i];
        break;
      case '--site':
        siteName = args[++i];
        break;
      case '--demo':
        isDemo = true;
        break;
      case '--min-impressions':
        minImpressions = parseInt(args[++i]) || 0;
        break;
      default:
        if (args[i].startsWith('-')) {
          console.error(`不明なオプション: ${args[i]}`);
          console.log(USAGE);
          process.exit(1);
        }
    }
  }

  let data;
  if (isDemo) {
    data = generateDemoData();
    console.log(`デモデータ: ${data.length}件のサンプルクエリを読み込みました`);
  } else if (inputPath) {
    if (!fs.existsSync(inputPath)) {
      console.error(`入力ファイルが見つかりません: ${inputPath}`);
      process.exit(1);
    }
    const text = fs.readFileSync(inputPath, 'utf8');
    data = parseCSV(text);
    console.log(`CSV読み込み: ${data.length}件のクエリをパースしました`);
  } else {
    console.error('--input または --demo を指定してください');
    console.log(USAGE);
    process.exit(1);
  }

  if (data.length === 0) {
    console.error('有効なデータがありません');
    process.exit(1);
  }

  const html = generateHTML(data, { siteName, minImpressions });
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`出力: ${outputPath} (${html.length.toLocaleString()} bytes)`);
  console.log(`統計: ${data.length}クエリ / 総impressions ${data.reduce((s,r)=>s+r.impressions,0).toLocaleString()} / 総clicks ${data.reduce((s,r)=>s+r.clicks,0).toLocaleString()}`);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main();
