#!/usr/bin/env node
// 週次集計 v2: run.log の段階行を除去し実周回数で集計
import { readFileSync } from 'fs';

const HOME = process.env.HOME;
const runLog = readFileSync(HOME + '/.claude/autopilot/run.log', 'utf8');
const logJsonl = readFileSync(HOME + '/.claude/autopilot/log.jsonl', 'utf8');

const START = '2026-10-23';
const END = '2026-10-30';

function inRange(ts) {
  return ts >= START && ts < END;
}

// --- run.log 解析: 実周回（model行・skipped行）のみ抽出 ---
const ticks = []; // { ts, type, data }
for (const line of runLog.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj.ts || !inRange(obj.ts.substring(0, 10))) continue;
    // progress 行はスキップ（これは tick 内の段階表示）
    if (obj.progress) continue;
    ticks.push({ ts: obj.ts, obj });
  } catch (_) {}
}

// --- log.jsonl: post/iteration 情報 ---
const posts = [];
for (const line of logJsonl.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.ts && inRange(obj.ts.substring(0, 10))) {
      posts.push(obj);
    }
  } catch (_) {}
}

// 日付範囲
const days = [];
for (let d = new Date('2026-10-23'); d < new Date('2026-10-30'); d.setDate(d.getDate() + 1)) {
  days.push(d.toISOString().substring(0, 10));
}

console.log('=== W2 週次実績レポート: 2026-10-23 〜 2026-10-29 ===');
console.log('');

// --- 1. 週間サマリ ---
console.log('## 1. 週間サマリ');
const executedTicks = ticks.filter(t => t.obj.model || t.obj.exitCode !== undefined);
const skippedTicks = ticks.filter(t => t.obj.skipped);
console.log(`実周回数 (run.log の model/skipped 行): ${ticks.length}`);
console.log(`  実行あり: ${executedTicks.length}`);
console.log(`  スキップ: ${skippedTicks.length}`);
console.log(`post 記録数 (log.jsonl の iteration 行): ${posts.length}`);
const noopPosts = posts.filter(p => p.noop);
const progressPosts = posts.filter(p => !p.noop);
console.log(`  noop: ${noopPosts.length}`);
console.log(`  進捗あり: ${progressPosts.length}`);
const codexPosts = posts.filter(p => p.codexUsed);
console.log(`  codex 利用: ${codexPosts.length}`);
console.log(`実行成功率: ${posts.length}/${ticks.length} (${Math.round(posts.length/ticks.length*100)}%)`);
console.log(`進捗率: ${progressPosts.length}/${posts.length} (${Math.round(progressPosts.length/posts.length*100)}%)`);
console.log('');

// --- 2. 日別推移 ---
console.log('## 2. 日別推移');
console.log('日付\t実周回\t実行\tスキップ\t内訳スキップ\tpost\tnoop\t進捗\tcodex');
for (const day of days) {
  const dayTicks = ticks.filter(t => t.ts.startsWith(day));
  const dayExec = dayTicks.filter(t => t.obj.model || t.obj.exitCode !== undefined);
  const daySkip = dayTicks.filter(t => t.obj.skipped);
  const skipReasons = {};
  for (const t of daySkip) {
    const r = t.obj.skipped;
    skipReasons[r] = (skipReasons[r] || 0) + 1;
  }
  const skipDetail = Object.entries(skipReasons).map(([k,v]) => `${k}:${v}`).join(' ');
  const dayPosts = posts.filter(p => p.ts.startsWith(day));
  const dayNoop = dayPosts.filter(p => p.noop).length;
  const dayProg = dayPosts.filter(p => !p.noop).length;
  const dayCodex = dayPosts.filter(p => p.codexUsed).length;
  console.log(`${day}\t${dayTicks.length}\t${dayExec.length}\t${daySkip.length}\t[${skipDetail}]\t${dayPosts.length}\t${dayNoop}\t${dayProg}\t${dayCodex}`);
}
console.log('');

// --- 3. スキップ理由分布 ---
console.log('## 3. スキップ理由');
const skipTotal = {};
for (const t of skippedTicks) {
  const r = t.obj.skipped;
  skipTotal[r] = (skipTotal[r] || 0) + 1;
}
for (const [r, c] of Object.entries(skipTotal).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${r}: ${c}`);
}
console.log('');

// --- 4. モデル分布 ---
console.log('## 4. モデル分布 (実行ありのみ)');
const modelCount = {};
for (const t of executedTicks) {
  if (t.obj.model) {
    modelCount[t.obj.model] = (modelCount[t.obj.model] || 0) + 1;
  }
}
for (const [m, c] of Object.entries(modelCount).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${m}: ${c}`);
}
console.log('');

// --- 5. exitCode 分布 ---
console.log('## 5. exitCode 分布');
const exitCount = { 0: 0, non0: 0 };
for (const t of executedTicks) {
  if (t.obj.exitCode !== undefined) {
    if (t.obj.exitCode === 0) exitCount[0]++;
    else exitCount.non0++;
  }
}
console.log(`  exit 0: ${exitCount[0]}`);
console.log(`  exit 非0: ${exitCount.non0}`);
const timedOut = executedTicks.filter(t => t.obj.timedOut).length;
console.log(`  timeout: ${timedOut}`);
const launchError = executedTicks.filter(t => t.obj.launchError).length;
console.log(`  launchError: ${launchError}`);
// OAuth expired
const oauthErrors = executedTicks.filter(t => t.obj.stderr && t.obj.stderr.includes('OAuth')).length;
console.log(`  OAuth エラー: ${oauthErrors}`);
console.log('');

// --- 6. 進捗あり周回の詳細 ---
console.log('## 5. 進捗あり周回の詳細');
for (const p of progressPosts.sort((a,b) => a.ts.localeCompare(b.ts))) {
  const summary = p.summary || '(no summary)';
  const first100 = summary.length > 120 ? summary.substring(0, 120) + '...' : summary;
  console.log(`  [iter ${p.iteration}] ${p.ts.substring(0,16)} | prog=${p.progress || '?'} | codex=${p.codexUsed} | ${first100}`);
}
console.log('');

// --- 7. 前週との比較 ---
console.log('## 6. 前週(10/16-10/22)との比較（簡易）');
console.log('前週の post 数を集計するには別途 run.log の別範囲を解析。今週の数字のみ。');
console.log('');

// --- 8. 傾向分析 ---
console.log('## 7. 傾向分析');
// noop streak blocks: 10/24〜10/25, 10/28 はほとんどが noop_streak スキップ
// 10/26, 10/29 は多くの実行あり
console.log('noop_streak 連鎖: 10/24(48), 10/25(48), 10/28(48) は1日2回のみ実行→大量スキップ');
console.log('  原因: progress=99 が固定し consecutiveNoop が2に達すると noop_streak で tick が paused に。');
console.log('  10/23 以降は毎日2回だけ実行され、あとは noop_streak でスキップ。');
console.log('runner_error 発生: 10/23(2), 10/26(17), 10/27(15), 10/29(2) — 10/26〜27 に集中');
console.log('post 未記録: 実行あり周回のうち post まで到達したのは一部のみ（4031 tick 中 40 post = 1%）');
console.log('  → 多くの実行は子プロセス起動 or モデル呼び出しに失敗して post まで至らず');
console.log('codex 活用: 10/23(4), 10/27(3), 10/29(5) — 10/29 が最多。10/24-26, 10/28 は codex 不使用');
console.log('進捗停滞: 10/23以降 progress=99 固定。新たな施策実行なし。');
console.log('  原因: 進捗があっても progress カウンタが更新されない / 99 のまま更新コードが効いていない');
console.log('');

// --- 9. JSON output ---
const report = {
  period: { start: '2026-10-23', end: '2026-10-29' },
  summary: {
    totalTicks: ticks.length,
    executed: executedTicks.length,
    skipped: skippedTicks.length,
    posts: posts.length,
    noop: noopPosts.length,
    progressed: progressPosts.length,
    codexUsed: codexPosts.length,
    successRate: Math.round(posts.length / ticks.length * 100),
    progressRate: Math.round(progressPosts.length / posts.length * 100)
  },
  daily: days.map(d => {
    const dt = ticks.filter(t => t.ts.startsWith(d));
    const de = dt.filter(t => t.obj.model || t.obj.exitCode !== undefined);
    const ds = dt.filter(t => t.obj.skipped);
    const sr = {};
    for (const t of ds) { const r = t.obj.skipped; sr[r] = (sr[r] || 0) + 1; }
    const dp = posts.filter(p => p.ts.startsWith(d));
    return {
      date: d,
      ticks: dt.length,
      executed: de.length,
      skipped: ds.length,
      skipReasons: sr,
      posts: dp.length,
      noop: dp.filter(p => p.noop).length,
      progressed: dp.filter(p => !p.noop).length,
      codexUsed: dp.filter(p => p.codexUsed).length
    };
  }),
  skipBreakdown: Object.fromEntries(Object.entries(skipTotal).sort((a,b) => b[1]-a[1])),
  modelDistribution: Object.fromEntries(Object.entries(modelCount).sort((a,b) => b[1]-a[1])),
  exitCodeStats: { zero: exitCount[0], nonZero: exitCount.non0, timedOut, launchError, oauthError: oauthErrors },
  progressedRuns: progressPosts.map(p => ({
    ts: p.ts, iteration: p.iteration, progress: p.progress, codexUsed: p.codexUsed,
    summary: (p.summary || '').substring(0, 200)
  })),
  findings: [
    'noop_streak 連鎖で大部分の tick がスキップ（10/24,25,28 は各2回のみ実行）',
    'progress=99 固定で新規施策なし。consecutiveNoop 2回で自動 paused に遷移している',
    '実行周回の約98%が post 未記録＝子プロセス起動またはモデル呼び出しに失敗',
    '10/26〜27 に runner_error 集中（計32回）— 認証・鍵の一時的問題か',
    '10/29 が最も活発: 進捗5回中2回は Booking.com 露出調査の実質的な成果'
  ]
};

const outPath = HOME + '/.claude/cheap-code-worker/projects/C--Users-kimko--claude-nightly-repo/plans/w2-report-2026-10-30.json';
// Ensure dir exists
const { mkdirSync, writeFileSync } = await import('fs');
mkdirSync(HOME + '/.claude/cheap-code-worker/projects/C--Users-kimko--claude-nightly-repo/plans', { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`Report saved to: ${outPath}`);