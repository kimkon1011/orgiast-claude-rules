#!/usr/bin/env node
// 2026-10-23〜10-29 の autopilot 週次実績集計
import { readFileSync } from 'fs';

const runLog = readFileSync(process.env.HOME + '/.claude/autopilot/run.log', 'utf8');
const logJsonl = readFileSync(process.env.HOME + '/.claude/autopilot/log.jsonl', 'utf8');

const START = '2026-10-23';
const END = '2026-10-30'; // exclusive

function inRange(ts) {
  return ts >= START && ts < END;
}

// Parse run.log
const runs = [];
for (const line of runLog.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.ts && inRange(obj.ts.substring(0, 10))) {
      runs.push(obj);
    }
  } catch (e) {
    // skip parse errors
  }
}

// Parse log.jsonl
const posts = [];
for (const line of logJsonl.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.ts && inRange(obj.ts.substring(0, 10))) {
      posts.push(obj);
    }
  } catch (e) {
    // skip parse errors
  }
}

console.log('=== 集計期間: 2026-10-23 〜 2026-10-29 ===');
console.log('');

// 1. 全体件数
console.log(`run.log エントリ数: ${runs.length}`);
console.log(`log.jsonl エントリ数: ${posts.length}`);
console.log('');

// 2. skipped 理由分布
const skippedCounts = {};
let executed = 0;
let skipped = 0;
for (const r of runs) {
  if (r.skipped) {
    skipped++;
    skippedCounts[r.skipped] = (skippedCounts[r.skipped] || 0) + 1;
  } else {
    executed++;
  }
}
console.log('--- スキップ理由分布 ---');
console.log(`実行あり: ${executed}`);
for (const [reason, count] of Object.entries(skippedCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  スキップ(${reason}): ${count}`);
}
console.log(`  スキップ合計: ${skipped}`);
console.log('');

// 3. 日別集計
const dailyCounts = {};
for (const r of runs) {
  const day = r.ts.substring(0, 10);
  if (!dailyCounts[day]) dailyCounts[day] = { total: 0, executed: 0, skipped: 0, noop: 0, progressed: 0, codexUsed: 0, byReason: {} };
  dailyCounts[day].total++;
  if (r.skipped) {
    dailyCounts[day].skipped++;
    dailyCounts[day].byReason[r.skipped] = (dailyCounts[day].byReason[r.skipped] || 0) + 1;
  } else {
    dailyCounts[day].executed++;
  }
}
for (const p of posts) {
  const day = p.ts.substring(0, 10);
  if (!dailyCounts[day]) dailyCounts[day] = { total: 0, executed: 0, skipped: 0, noop: 0, progressed: 0, codexUsed: 0, byReason: {} };
  if (p.noop) dailyCounts[day].noop++;
  else dailyCounts[day].progressed++;
  if (p.codexUsed) dailyCounts[day].codexUsed++;
}

console.log('--- 日別集計 ---');
console.log('日付\t計\t実行\tスキップ\tnoop\t進捗あり\tcodex利用\t内訳');
const days = Object.keys(dailyCounts).sort();
for (const day of days) {
  const d = dailyCounts[day];
  const reasonStr = Object.entries(d.byReason).map(([k,v]) => `${k}:${v}`).join(' ');
  console.log(`${day}\t${d.total}\t${d.executed}\t${d.skipped}\t${d.noop}\t${d.progressed}\t${d.codexUsed}\t[${reasonStr}]`);
}
console.log('');

// 4. 週次サマリ
let totalNoop = 0, totalProgressed = 0, totalCodexUsed = 0;
for (const p of posts) {
  if (p.noop) totalNoop++;
  else totalProgressed++;
  if (p.codexUsed) totalCodexUsed++;
}
console.log('--- 週次サマリ ---');
console.log(`週間 tick 数: ${runs.length}`);
console.log(`post された周回: ${posts.length}`);
console.log(`  noop: ${totalNoop}`);
console.log(`  進捗あり: ${totalProgressed}`);
console.log(`  codex 利用: ${totalCodexUsed}`);
console.log(`実行成功率: ${posts.length}/${runs.length} (${Math.round(posts.length/runs.length*100)}%)`);
console.log(`進捗率: ${totalProgressed}/${posts.length} (${Math.round(totalProgressed/posts.length*100)}%)`);
console.log('');

// 5. model 分布
const modelCounts = {};
for (const r of runs) {
  if (r.model) {
    modelCounts[r.model] = (modelCounts[r.model] || 0) + 1;
  }
}
console.log('--- モデル分布 (実行ありのみ) ---');
for (const [m, c] of Object.entries(modelCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${m}: ${c}`);
}
console.log('');

// 6. exitCode 分布
const exitCounts = {};
for (const r of runs) {
  if (r.exitCode !== undefined) {
    const key = r.exitCode === 0 ? '0' : `非0(${r.exitCode})`;
    exitCounts[key] = (exitCounts[key] || 0) + 1;
  }
}
console.log('--- exitCode 分布 (実行ありのみ) ---');
for (const [code, count] of Object.entries(exitCounts).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${code}: ${count}`);
}
console.log('');

// 7. 前週(10/16-10/22)との比較
console.log('--- 前週比較 (簡易) ---');
const prevWeekRuns = runs.filter(r => r.ts.substring(0,10) >= '2026-10-16' && r.ts.substring(0,10) < '2026-10-23').length;
// これはこのスクリプトでは1回の実行で両方参照できないので、実際は別途。
// ここでは今週のデータのみ表示
console.log('前週データは別途集計が必要。今週のデータのみ。');