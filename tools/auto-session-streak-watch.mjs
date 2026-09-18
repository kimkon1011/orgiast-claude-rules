#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const DAY_RE = /^\d{4}-\d{2}-\d{2}-(.+)$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

export function jobKeyFor(run, runFile) {
  if (run?.source === 'feedback' && run.issue?.repo && run.issue?.number !== undefined) {
    return `feedback:${run.issue.repo}#${run.issue.number}`;
  }
  const stem = path.basename(runFile, path.extname(runFile));
  return stem.match(DAY_RE)?.[1] || stem;
}

export function resolveSummaryPath(summaryFile, { home, runsDir }) {
  if (!summaryFile) return '';
  if (fs.existsSync(summaryFile)) return summaryFile;
  const windows = String(summaryFile).match(/^([A-Za-z]):[\\/](.*)$/);
  if (windows && process.platform !== 'win32') {
    const mounted = `/mnt/${windows[1].toLowerCase()}/${windows[2].replaceAll('\\', '/')}`;
    if (fs.existsSync(mounted)) return mounted;
  }
  // Runs copied between Windows and WSL retain the old absolute path. The basename
  // remains authoritative because summaries and JSON records are siblings.
  return path.join(runsDir || path.join(home, '.claude', 'auto-session', 'runs'), path.win32.basename(String(summaryFile)));
}

export function evaluateRun(run, runFile, stat, options) {
  const runsDir = path.dirname(runFile);
  const summaryPath = resolveSummaryPath(run?.summaryFile, { ...options, runsDir });
  let summarySize = -1;
  try { summarySize = fs.statSync(summaryPath).size; } catch {}
  const started = Date.parse(run?.startedAt);
  const when = Number.isFinite(started) ? new Date(started) : stat.mtime;
  const date = when.toISOString().slice(0, 10);
  const success = run?.status === 'success'
    && run?.exitCode === 0
    && typeof run?.summary === 'string'
    && run.summary.trim().length > 0
    && summarySize > 0;
  return { run, runFile, summaryPath, when, date, success };
}

export function formatDecisionRequest(item) {
  const severity = item.streak >= 3 ? '重大' : '異常';
  const stderr = String(item.latest.run.stderr || '（stderr なし）').slice(0, 300);
  return [
    `【auto-session ${severity}】${item.jobKey} が ${item.streak} 日連続失敗しています。`,
    `最新エラー: ${stderr}`,
    `最初の失敗日: ${item.firstFailureDate}`,
    `最後の成功日: ${item.lastSuccessDate || '成功記録なし'}`,
    '',
    'kim に選んでほしい対応:',
    '1. 原因調査を自動で始める（セッションを起票する）',
    '2. このジョブを一時停止する',
    '3. 無視する（既知・対応中）',
    '',
    `run JSON: ${item.latest.runFile}`,
    `summary: ${item.latest.summaryPath || item.latest.run.summaryFile || '（指定なし）'}`
  ].join('\n');
}

async function defaultNotifyImpl(text, { home }) {
  const { notifyKim } = await import('./notify-kim.mjs');
  const result = await notifyKim(text, { home, webhookFallback: false });
  if (result.delivered !== 'dm') throw new Error(`kim への DM 送信失敗: ${result.reason || '不明な理由'}`);
  return result;
}

export async function runAutoSessionStreakWatch({
  home = process.env.ORGIAST_HOME || os.homedir(),
  now = new Date(),
  dryRun = false,
  notifyImpl = defaultNotifyImpl,
  runsDir = path.join(home, '.claude', 'auto-session', 'runs'),
  stateFile = path.join(home, '.claude', 'auto-session', 'streak-watch-state.json')
} = {}) {
  const groups = new Map();
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir).filter((entry) => entry.endsWith('.json'))) {
      const runFile = path.resolve(runsDir, name);
      const run = readJson(runFile);
      if (!run || name === path.basename(stateFile)) continue;
      const evaluated = evaluateRun(run, runFile, fs.statSync(runFile), { home });
      const key = jobKeyFor(run, runFile);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(evaluated);
    }
  }

  const detected = [];
  for (const [jobKey, runs] of groups) {
    const days = new Map();
    for (const run of runs) {
      if (!days.has(run.date)) days.set(run.date, []);
      days.get(run.date).push(run);
    }
    const ordered = [...days.entries()].sort(([a], [b]) => b.localeCompare(a));
    let streak = 0;
    let firstFailureDate = '';
    let lastSuccessDate = '';
    for (const [date, dayRuns] of ordered) {
      const daySucceeded = dayRuns.some((run) => run.success);
      if (daySucceeded) {
        lastSuccessDate = date;
        break;
      }
      streak += 1;
      firstFailureDate = date;
    }
    if (streak < 2) continue;
    const failedRuns = runs.filter((run) => !run.success && ordered.slice(0, streak).some(([date]) => date === run.date));
    const latest = failedRuns.sort((a, b) => b.when - a.when)[0];
    const item = { jobKey, streak, firstFailureDate, lastSuccessDate, latest };
    item.message = formatDecisionRequest(item);
    detected.push(item);
  }

  const state = readJson(stateFile) || {};
  const today = now.toISOString().slice(0, 10);
  const notified = [];
  const suppressed = [];
  for (const item of detected) {
    const previous = state[item.jobKey];
    if (previous?.lastNotifiedDate === today && previous.lastNotifiedStreak >= item.streak) {
      suppressed.push(item);
      continue;
    }
    if (!dryRun) {
      await notifyImpl(item.message, { home, item });
      state[item.jobKey] = { lastNotifiedDate: today, lastNotifiedStreak: item.streak };
      writeJsonAtomic(stateFile, state);
    }
    notified.push(item);
  }
  return { detected, notified, suppressed };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const result = await runAutoSessionStreakWatch({ dryRun });
  for (const item of result.detected) console.log(item.message, '\n');
  if (!result.detected.length) console.log('ok: 連続失敗なし');
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await main();
