#!/usr/bin/env node
// W1 vs W2 SVG chart generator (simplified)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '/c/Users/kimko';

const data = {
  activity: {
    w1: [71, 30, 41, 27],
    w2: [40, 30, 10, 12],
    labels: ['post記録', 'noop', '進捗あり', 'codex利用'],
    colors: ['#64b5f6', '#ffb74d', '#66bb6a', '#ab47bc']
  },
  skipReasons: {
    w1: [67, 77, 78, 47, 0],
    w2: [211, 36, 21, 0, 4],
    labels: ['noop連鎖', '実行障害', '日次上限', '判断待ち', 'hst稼働'],
    colors: ['#ef5350', '#ffb74d', '#64b5f6', '#26a69a', '#ab47bc']
  }
};

function makeChart(data, title, filename, maxH = 300, W = 700) {
  const H = maxH + 120;
  const PAD = { t: 50, r: 30, b: 80, l: 60 };
  const GW = W - PAD.l - PAD.r;
  const n = data.labels.length;
  const BAR_W = Math.min(40, (GW / n - 20) / 2);
  const GAP = 8;
  const GROUP_W = (BAR_W * 2 + GAP * 1.5);
  const totalGroupW = GROUP_W * n;
  const startX = PAD.l + (GW - totalGroupW) / 2;

  const maxVal = Math.max(...data.w1, ...data.w2) * 1.25;

  const C_GRID = '#2a3a5e';
  const C_TEXT = '#c8d6e5';
  const C_W1 = '#64b5f6';
  const C_W2 = '#ffb74d';

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  let svg = '';
  const e = (...args) => { svg += args.join(' ') + '\n'; };

  e(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  e(`<rect width="${W}" height="${H}" fill="#1a1a2e"/>`);
  e(`<rect x="${PAD.l - 10}" y="${PAD.t}" width="${GW + 20}" height="${maxH + 10}" fill="#16213e" rx="6"/>`);
  e(`<text x="${W/2}" y="30" fill="${C_TEXT}" font-size="16" text-anchor="middle" font-weight="bold" font-family="sans-serif">${esc(title)}</text>`);
  e(`<text x="${W/2}" y="${H - 8}" fill="#888" font-size="9" text-anchor="middle" font-family="sans-serif">Autopilot headless tick weekly comparison</text>`);

  // Grid lines
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const val = Math.round(maxVal * i / steps);
    const y = PAD.t + maxH - (maxH * i / steps);
    e(`<line x1="${PAD.l - 5}" y1="${y}" x2="${PAD.l + GW + 5}" y2="${y}" stroke="${C_GRID}" stroke-width="0.5" stroke-dasharray="4,3"/>`);
    e(`<text x="${PAD.l - 10}" y="${y + 4}" fill="${C_TEXT}" font-size="10" text-anchor="end" font-family="sans-serif">${val}</text>`);
  }

  // Bars
  for (let i = 0; i < n; i++) {
    const x = startX + i * GROUP_W;
    const w1v = data.w1[i], w2v = data.w2[i];
    const h1 = w1v / maxVal * maxH;
    const h2 = w2v / maxVal * maxH;

    // Bar W1
    if (h1 > 0) {
      const bx1 = x;
      e(`<rect x="${bx1}" y="${PAD.t + maxH - h1}" width="${BAR_W}" height="${h1}" fill="${C_W1}" opacity="0.85" rx="3"/>`);
      e(`<text x="${bx1 + BAR_W/2}" y="${PAD.t + maxH - h1 - 5}" fill="${C_W1}" font-size="11" text-anchor="middle" font-family="sans-serif">${w1v}</text>`);
    }
    // Bar W2
    if (h2 > 0) {
      const bx2 = x + BAR_W + GAP;
      e(`<rect x="${bx2}" y="${PAD.t + maxH - h2}" width="${BAR_W}" height="${h2}" fill="${C_W2}" opacity="0.85" rx="3"/>`);
      e(`<text x="${bx2 + BAR_W/2}" y="${PAD.t + maxH - h2 - 5}" fill="${C_W2}" font-size="11" text-anchor="middle" font-family="sans-serif">${w2v}</text>`);
    }
    // Label
    const lx = startX + i * GROUP_W + GROUP_W / 2;
    e(`<text x="${lx}" y="${PAD.t + maxH + 18}" fill="${C_TEXT}" font-size="11" text-anchor="middle" font-family="sans-serif">${esc(data.labels[i])}</text>`);
    // Diff arrow
    const diff = w2v - w1v;
    const arrow = diff > 0 ? `↑+${diff}` : diff < 0 ? `↓${diff}` : '—';
    const arrowColor = diff > 0 ? '#ef5350' : diff < 0 ? '#66bb6a' : '#888';
    e(`<text x="${lx}" y="${PAD.t + maxH + 33}" fill="${arrowColor}" font-size="10" text-anchor="middle" font-family="sans-serif">${arrow}</text>`);
  }

  // Legend
  const ly = PAD.t + maxH + 48;
  e(`<rect x="${PAD.l}" y="${ly}" width="12" height="12" fill="${C_W1}" opacity="0.85" rx="2"/>`);
  e(`<text x="${PAD.l + 18}" y="${ly + 10}" fill="${C_TEXT}" font-size="10" text-anchor="start" font-family="sans-serif">W1 (10/16-22)</text>`);
  e(`<rect x="${PAD.l + 120}" y="${ly}" width="12" height="12" fill="${C_W2}" opacity="0.85" rx="2"/>`);
  e(`<text x="${PAD.l + 138}" y="${ly + 10}" fill="${C_TEXT}" font-size="10" text-anchor="start" font-family="sans-serif">W2 (10/23-29)</text>`);

  e('</svg>');
  return svg;
}

const activity = makeChart(data.activity, 'ActW1 vs W2 週次アクティビティ', 'activity.svg', 280, 700);
const skip = makeChart(data.skipReasons, 'SkiReason 分布: W1 vs W2', 'skip.svg', 280, 700);

const outDir = join(HOME, '.claude', 'cheap-code-worker', 'projects', 'C--Users-kimko--claude-nightly-repo', 'plans');
writeFileSync(join(outDir, 'w2-chart-activity.svg'), activity);
writeFileSync(join(outDir, 'w2-chart-skipreasons.svg'), skip);
console.log('SVG charts saved to:');
console.log(`  ${join(outDir, 'w2-chart-activity.svg')}`);
console.log(`  ${join(outDir, 'w2-chart-skipreasons.svg')}`);