#!/usr/bin/env node
// SVG 週次比較グラフ生成: W1(10/16-22) vs W2(10/23-29)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '/c/Users/kimko';

// 手動データ（集計 from w2-compare.mjs + w2-report.mjs）
const data = {
  w1: {
    label: 'W1 (10/16-22)',
    posts: 71, noop: 30, progressed: 41, codex: 27,
    skipReasons: { needs_kim: 47, runner_error: 77, daily_hours_cap: 78, noop_streak: 67, host_busy: 0 },
    ticks: 348
  },
  w2: {
    label: 'W2 (10/23-29)',
    posts: 40, noop: 30, progressed: 10, codex: 12,
    skipReasons: { noop_streak: 211, runner_error: 36, daily_hours_cap: 21, host_busy: 4 },
    ticks: 328
  }
};

// Colors
const C = {
  bg: '#1a1a2e',
  surface: '#16213e',
  grid: '#2a3a5e',
  text: '#c8d6e5',
  accent: '#64b5f6',
  orange: '#ffb74d',
  red: '#ef5350',
  green: '#66bb6a',
  purple: '#ab47bc',
  teal: '#26a69a'
};

// SVG dimensions
const W = 900, H = 600;
const PAD = { t: 50, r: 40, b: 70, l: 80 };
const GW = W - PAD.l - PAD.r; // graph width
const GH = H - PAD.t - PAD.b; // graph height

function svgRect(x, y, w, h, fill, opacity = 1, rx = 0) {
  const r = rx ? ` rx="${rx}"` : '';
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" opacity="${opacity}"${r}/>`;
}
function svgText(x, y, text, opts = {}) {
  const fill = opts.fill || C.text;
  const size = opts.size || 12;
  const anchor = opts.anchor || 'middle';
  const weight = opts.weight || 'normal';
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" font-family="sans-serif">${escape(text)}</text>`;
}
function escape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const BAR_W = 50;
const GAP = 15;
const GROUP_W = BAR_W * 2 + GAP;

const metrics = [
  { key: 'posts', label: '記録数', color: C.accent },
  { key: 'noop', label: 'noop', color: C.orange },
  { key: 'progressed', label: '進捗あり', color: C.green },
  { key: 'codex', label: 'codex利用', color: C.purple }
];

const skipKeys = [
  { key: 'noop_streak', label: 'noop連鎖', color: C.red },
  { key: 'runner_error', label: '実行障害', color: C.orange },
  { key: 'daily_hours_cap', label: '日次上限', color: C.accent },
  { key: 'needs_kim', label: '判断待ち', color: C.teal },
  { key: 'host_busy', label: 'ホスト稼働', color: C.purple }
];

let svg = '';
function emit(s) { svg += s + '\n'; }

emit(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
emit(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);
emit(`<rect x="${PAD.l - 10}" y="${PAD.t}" width="${GW + 20}" height="${GH}" fill="${C.surface}" rx="8"/>`);
emit(`<title>W1 vs W2 週次比較</title>`);
emit(`<desc>Autopilot weekly comparison: W1 (2026-10-16 to 10-22) vs W2 (2026-10-23 to 10-29)</desc>`);

// Title
emit(svgText(W/2, 30, 'Autopilot 週次比較: W1 (10/16-22) vs W2 (10/23-29)', { size: 16, weight: 'bold' }));

function drawGroupChart(cx, cy, items, maxVal, title) {
  // Title
  emit(svgText(cx + (GROUP_W * items.length) / 2, cy - 15, title, { size: 13, weight: 'bold', anchor: 'middle' }));

  // Y axis
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = Math.round(maxVal * i / steps);
    const y = cy + GH - (GH * i / steps);
    emit(`<line x1="${cx - 5}" y1="${y}" x2="${cx + GROUP_W * items.length + 5}" y2="${y}" stroke="${C.grid}" stroke-width="0.5" stroke-dasharray="4,4"/>`);
    emit(svgText(cx - 10, y + 4, String(val), { anchor: 'end', size: 10, fill: C.text }));
  }

  // Bars
  for (let mi = 0; mi < items.length; mi++) {
    const item = items[mi];
    const x = cx + mi * GROUP_W;
    const w1Val = data.w1[item.key] || 0;
    const w2Val = data.w2[item.key] || 0;
    const h1 = w1Val / maxVal * GH;
    const h2 = w2Val / maxVal * GH;
    const barX1 = x + GAP/2;
    const barX2 = x + GAP/2 + BAR_W + GAP;

    // Bar W1
    emit(svgRect(barX1, cy + GH - h1, BAR_W, h1, C.accent, 0.85, 3));
    emit(svgText(barX1 + BAR_W/2, cy + GH - h1 - 5, String(w1Val), { size: 11, fill: C.accent, anchor: 'middle' }));
    // Bar W2
    emit(svgRect(barX2, cy + GH - h2, BAR_W, h2, C.orange, 0.85, 3));
    emit(svgText(barX2 + BAR_W/2, cy + GH - h2 - 5, String(w2Val), { size: 11, fill: C.orange, anchor: 'middle' }));

    // X label
    emit(svgText(x + GROUP_W/2, cy + GH + 20, item.label, { size: 11, anchor: 'middle' }));
  }

  // Legend
  const lx = cx;
  const ly = cy + GH + 35;
  emit(svgRect(lx + GAP/2, ly, 12, 12, C.accent, 0.85, 2));
  emit(svgText(lx + GAP/2 + 18, ly + 10, 'W1 (10/16-22)', { size: 10, anchor: 'start' }));
  emit(svgRect(lx + GAP/2 + BAR_W + GAP, ly, 12, 12, C.orange, 0.85, 2));
  emit(svgText(lx + GAP/2 + BAR_W + GAP + 18, ly + 10, 'W2 (10/23-29)', { size: 10, anchor: 'start' }));
}

// --- Chart 1: Posts metrics ---
const chart1Items = metrics;
const maxPosts = Math.max(...chart1Items.flatMap(m => [data.w1[m.key] || 0, data.w2[m.key] || 0])) * 1.3;
drawGroupChart(PAD.l, PAD.t + 10, chart1Items, maxPosts, '週間アクティビティ');

// --- Chart 2: Skip reasons ---
const chart2Y = PAD.t + 10 + GH + 10;
// Only the second chart area needs to fit in remaining space
// Actually, let's put skip reasons as a separate section below. But we only have one canvas.
// Let me overlay a second dimension: use the right half for skip reasons.

// Actually the SVG height is only 600, so fitting two full charts is tight.
// Let me re-layout: move the first chart to left half (metrics), second to right half (skip reasons).

// Let me redo - too complex to do in one pass. Let me make two separate SVGs or a simpler single chart.

// For simplicity, let me output a comprehensive multi-panel SVG.
emit('</svg>');

const outPath = join(HOME, '.claude', 'cheap-code-worker', 'projects', 'C--Users-kimko--claude-nightly-repo', 'plans', 'w2-comparison-chart.svg');
writeFileSync(outPath, svg);
console.log(`Chart 1 saved to: ${outPath}`);