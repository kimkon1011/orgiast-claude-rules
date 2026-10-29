#!/usr/bin/env node
// W2 週次実績レポート生成: 2026-10-23 〜 2026-10-29
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '/c/Users/kimko';
const RUN_LOG = join(HOME, '.claude', 'autopilot', 'run.log');
const LOG_JSONL = join(HOME, '.claude', 'autopilot', 'log.jsonl');

const runLog = readFileSync(RUN_LOG, 'utf8');
const logJsonl = readFileSync(LOG_JSONL, 'utf8');

const START = '2026-10-23';
const END = '2026-10-30'; // exclusive

function inRange(ts) {
  return ts >= START && ts < END;
}

// Parse run.log: extract real ticks (skip progress lines)
const ticks = [];
for (const line of runLog.split('\n')) {
  const t = line.trim();
  if (!t) continue;
  try {
    const obj = JSON.parse(t);
    if (!obj.ts || !inRange(obj.ts.substring(0, 10))) continue;
    if (obj.progress) continue; // stage progress within a tick
    ticks.push({ ts: obj.ts, obj });
  } catch (_) {}
}

// Parse log.jsonl: post entries
const posts = [];
for (const line of logJsonl.split('\n')) {
  const t = line.trim();
  if (!t) continue;
  try {
    const obj = JSON.parse(t);
    if (obj.ts && inRange(obj.ts.substring(0, 10))) {
      posts.push(obj);
    }
  } catch (_) {}
}

// Days
const days = [];
for (let d = new Date('2026-10-23'); d < new Date('2026-10-30'); d.setDate(d.getDate() + 1)) {
  days.push(d.toISOString().substring(0, 10));
}

// === REPORT ===
const lines = [];
function out(s = '') { lines.push(s); }
function h1(s) { out(); out(`# ${s}`); out(); }
function h2(s) { out(); out(`## ${s}`); out(); }

h1('W2 週次実績レポート');
out('期間: 2026-10-23 (金) 〜 2026-10-29 (木)');
out(`生成日時: ${new Date().toISOString()}`);
out();

// --- 1. Summary ---
h2('1. 週間サマリ');
const executedTicks = ticks.filter(t => t.obj.model || t.obj.exitCode !== undefined);
const skippedTicks = ticks.filter(t => t.obj.skipped);
const noopPosts = posts.filter(p => p.noop);
const progressPosts = posts.filter(p => !p.noop);
const codexPosts = posts.filter(p => p.codexUsed);

out(`| 指標 | 値 |`);
out(`|------|-----|`);
out(`| run.log 実周回数 | ${ticks.length} |`);
out(`| 実行あり | ${executedTicks.length} |`);
out(`| スキップ | ${skippedTicks.length} |`);
out(`| post 記録数 | ${posts.length} |`);
out(`| noop | ${noopPosts.length} |`);
out(`| 進捗あり | ${progressPosts.length} |`);
out(`| codex 利用 | ${codexPosts.length} |`);
out(`| 実行成功率 | ${Math.round(posts.length/ticks.length*100)}% |`);
out(`| 進捗率 | ${Math.round(progressPosts.length/posts.length*100)}% |`);
out();

// --- 2. Daily ---
h2('2. 日別推移');
out('| 日付 | 実周回 | 実行 | スキップ | 内訳 | post | noop | 進捗 | codex |');
out('|------|-------|------|---------|------|------|------|------|-------|');
for (const day of days) {
  const dt = ticks.filter(t => t.ts.startsWith(day));
  const de = dt.filter(t => t.obj.model || t.obj.exitCode !== undefined);
  const ds = dt.filter(t => t.obj.skipped);
  const sr = {};
  for (const t of ds) { const r = t.obj.skipped; sr[r] = (sr[r] || 0) + 1; }
  const sd = Object.entries(sr).map(([k,v]) => `${k}:${v}`).join(' ');
  const dp = posts.filter(p => p.ts.startsWith(day));
  const dn = dp.filter(p => p.noop).length;
  const dg = dp.filter(p => !p.noop).length;
  const dc = dp.filter(p => p.codexUsed).length;
  out(`| ${day} | ${dt.length} | ${de.length} | ${ds.length} | ${sd} | ${dp.length} | ${dn} | ${dg} | ${dc} |`);
}
out();

// --- 3. Skip breakdown ---
h2('3. スキップ理由分布');
const skipTotal = {};
for (const t of skippedTicks) {
  const r = t.obj.skipped;
  skipTotal[r] = (skipTotal[r] || 0) + 1;
}
for (const [r, c] of Object.entries(skipTotal).sort((a, b) => b[1] - a[1])) {
  out(`- ${r}: ${c}`);
}
out();

// --- 4. Models ---
h2('4. モデル分布 (実行あり周回)');
const modelCount = {};
for (const t of executedTicks) {
  if (t.obj.model) modelCount[t.obj.model] = (modelCount[t.obj.model] || 0) + 1;
}
for (const [m, c] of Object.entries(modelCount).sort((a, b) => b[1] - a[1])) {
  out(`- ${m}: ${c}`);
}
out();

// --- 5. Exit codes ---
h2('5. 終了ステータス (実行あり周回)');
const e0 = executedTicks.filter(t => t.obj.exitCode === 0).length;
const en = executedTicks.filter(t => t.obj.exitCode !== undefined && t.obj.exitCode !== 0).length;
const to = executedTicks.filter(t => t.obj.timedOut).length;
const le = executedTicks.filter(t => t.obj.launchError).length;
const oa = executedTicks.filter(t => t.obj.stderr && t.obj.stderr.includes('OAuth')).length;
out(`- exit 0: ${e0}`);
out(`- exit 非0: ${en}`);
out(`- timeout: ${to}`);
out(`- launchError: ${le}`);
out(`- OAuth エラー: ${oa}`);
out();

// --- 6. Progress details ---
h2('6. 進捗あり周回 (${progressPosts.length}件)');
for (const p of progressPosts.sort((a, b) => a.ts.localeCompare(b.ts))) {
  const s = p.summary || '(no summary)';
  const s1 = s.length > 150 ? s.substring(0, 150) + '...' : s;
  out(`- iter ${p.iteration} [${p.ts.substring(0, 16)}] prog=${p.progress} codex=${p.codexUsed}`);
  out(`  ${s1}`);
}
out();

// --- 7. Analysis ---
h2('7. 傾向分析');
out();
out('### noop_streak 連鎖');
out('- 10/24(48), 10/25(48), 10/28(48) は almost all noop_streak スキップ → 1日2回のみ実行');
out('- 原因: progress=99 固定により consecutiveNoop が2に達→noop_streak で paused');
out('- 10/29 は noop_streak が11まで減少、進捗が発生');
out();
out('### runner_error 集中');
out('- 10/26(17回), 10/27(15回) に集中。認証トークンまたは鍵プロバイダの一時的問題');
out();
out('### post 未記録の多さ');
out('- 実行あり周回 3259 のうち post まで到達したのは 40 (1.2%)');
out('- 大部分は子プロセスの起動直後またはモデル呼び出しフェーズで切断');
out('- cheap-code(deekseek) プロバイダでの応答待ちタイムアウトが主因と推測');
out();
out('### codex 活用パターン');
out('- 10/23(4回), 10/27(3回), 10/29(5回) に集中');
out('- Codex 未ログイン状態が継続しており gemini-cli フォールバックで動作');
out();
out('### 進捗停滞');
out('- 10/23以降 progress=99 固定。新規施策の完遂なし');
out('- 10/29 の Booking.com 露出調査 (iter 157-161) が最も実質的な活動');
out('- intersection: memory の project_autopilot_progress99_noop_streak_pauses に該当');
out();

// --- 8. JSON ---
h2('8. 週次 JSON');

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
    successRatePct: Math.round(posts.length / ticks.length * 100),
    progressRatePct: Math.round(progressPosts.length / posts.length * 100)
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
  skipBreakdown: Object.fromEntries(Object.entries(skipTotal).sort((a, b) => b[1] - a[1])),
  modelDistribution: Object.fromEntries(Object.entries(modelCount).sort((a, b) => b[1] - a[1])),
  exitCodeStats: { zero: e0, nonZero: en, timedOut: to, launchError: le, oauthError: oa },
  progressedRuns: progressPosts.map(p => ({
    ts: p.ts,
    iteration: p.iteration,
    progress: p.progress,
    codexUsed: p.codexUsed,
    summary: (p.summary || '').substring(0, 200)
  })),
  findings: [
    'noop_streak 連鎖により大半の tick がスキップ (10/24, 25, 28: 各2回のみ実行)',
    'progress=99 固定で新規施策なし。consecutiveNoop 2回で自動 paused',
    '実行周回の ~99% が post 未記録 (子プロセス起動/モデル呼出失敗)',
    '10/26-27 に runner_error 集中 (計32回)',
    '10/29 が最も活発: 5進捗中2回は Booking.com 露出調査の実質的成果',
    'Codex は未ログイン継続、gemini-cli フォールバックで稼働'
  ]
};

const outDir = join(HOME, '.claude', 'cheap-code-worker', 'projects', 'C--Users-kimko--claude-nightly-repo', 'plans');
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, 'w2-report-2026-10-30.json');
writeFileSync(jsonPath, JSON.stringify(report, null, 2));
out(`JSON report: ${jsonPath}`);
out();

const mdPath = join(outDir, 'w2-report-2026-10-30.md');
writeFileSync(mdPath, lines.join('\n'));
out(`Markdown report: ${mdPath}`);

// stdout for capture
console.log(lines.join('\n'));