#!/usr/bin/env node
// 前週(10/16-10/22) 集計 + 週次比較表生成
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '/c/Users/kimko';
const runLog = readFileSync(join(HOME, '.claude', 'autopilot', 'run.log'), 'utf8');
const logJsonl = readFileSync(join(HOME, '.claude', 'autopilot', 'log.jsonl'), 'utf8');

function aggregateWeek(start, end) {
  const ticks = [];
  for (const line of runLog.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (!obj.ts) continue;
      const d = obj.ts.substring(0, 10);
      if (d < start || d >= end) continue;
      if (obj.progress) continue;
      ticks.push(obj);
    } catch (_) {}
  }
  const posts = [];
  for (const line of logJsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (!obj.ts) continue;
      const d = obj.ts.substring(0, 10);
      if (d < start || d >= end) continue;
      posts.push(obj);
    } catch (_) {}
  }
  return { ticks, posts };
}

const w1 = aggregateWeek('2026-10-16', '2026-10-23');
const w2 = aggregateWeek('2026-10-23', '2026-10-30');

console.log('=== 週次比較: W1(10/16-10/22) vs W2(10/23-10/29) ===');
console.log('');
console.log('| 指標 | W1 (10/16-22) | W2 (10/23-29) | 差分 |');
console.log('|------|-------------|-------------|------|');
const rows = [
  ['実周回数', w1.ticks.length, w2.ticks.length],
  ['post 記録', w1.posts.length, w2.posts.length],
  ['noop', w1.posts.filter(p => p.noop).length, w2.posts.filter(p => p.noop).length],
  ['進捗あり', w1.posts.filter(p => !p.noop).length, w2.posts.filter(p => !p.noop).length],
  ['codex 利用', w1.posts.filter(p => p.codexUsed).length, w2.posts.filter(p => p.codexUsed).length],
];
for (const [label, w1v, w2v] of rows) {
  const diff = w2v - w1v;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  console.log(`| ${label} | ${w1v} | ${w2v} | ${diffStr} |`);
}
console.log('');

// week-on-week progress comparison
const w1Skip = {};
const w2Skip = {};
for (const t of w1.ticks.filter(t => t.skipped)) w1Skip[t.skipped] = (w1Skip[t.skipped] || 0) + 1;
for (const t of w2.ticks.filter(t => t.skipped)) w2Skip[t.skipped] = (w2Skip[t.skipped] || 0) + 1;

console.log('--- スキップ理由比較 ---');
console.log('| 理由 | W1 | W2 |');
console.log('|------|----|----|');
const allReasons = new Set([...Object.keys(w1Skip), ...Object.keys(w2Skip)]);
for (const r of allReasons) {
  console.log(`| ${r} | ${w1Skip[r] || 0} | ${w2Skip[r] || 0} |`);
}