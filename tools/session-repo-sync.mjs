#!/usr/bin/env node
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const DEFAULT_TARGET = String.raw`C:\Users\uers\.claude\auto-session-tree`;
const DEFAULT_PROJECTS_DIR = String.raw`C:\Users\uers\.claude\projects`;
const DEFAULT_LEDGER_PATH = String.raw`C:\Users\uers\.claude\hook-selfheal-ledger.jsonl`;
const QUIET_THRESHOLD_MS = 300_000;

export function isWorkingTreeClean(porcelainOutput) {
  return String(porcelainOutput ?? '').trim().length === 0;
}

export function isQuietWindow({ nowMs, transcriptMtimesMs, thresholdMs }) {
  return !transcriptMtimesMs.some((mtime) => nowMs - mtime < thresholdMs);
}

export function findTranscriptMtimesMs({
  projectsDir = DEFAULT_PROJECTS_DIR,
  fs = nodeFs,
  nowMs: _nowMs,
} = {}) {
  const mtimes = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.name;
      const entryPath = path.join(directory, name);
      let stat;
      try {
        stat = fs.statSync(entryPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(entryPath);
      else if (stat.isFile() && name.toLowerCase().endsWith('.jsonl')) mtimes.push(stat.mtimeMs);
    }
  };

  visit(projectsDir);
  return mtimes;
}

export function planSyncAction({ headSha, targetSha }) {
  if (headSha === targetSha) return { needed: false, args: [] };
  return { needed: true, args: ['checkout', targetSha, '--quiet'] };
}

function runGit(target, args, spawn = spawnSync) {
  return spawn('git', ['-C', target, ...args], { encoding: 'utf8', windowsHide: true });
}

export function main({
  env = process.env,
  fs = nodeFs,
  nowMs = Date.now(),
  projectsDir = DEFAULT_PROJECTS_DIR,
  ledgerPath = DEFAULT_LEDGER_PATH,
  spawn = spawnSync,
} = {}) {
  try {
    const target = env.SESSION_REPO_SYNC_TARGET || DEFAULT_TARGET;
    const status = runGit(target, ['status', '--porcelain'], spawn);
    if (status.error || status.status !== 0) {
      console.error('[session-repo-sync] git status失敗、スキップ');
      return;
    }
    if (!isWorkingTreeClean(status.stdout)) {
      console.error('[session-repo-sync] 未コミットあり、スキップ');
      return;
    }

    const transcriptMtimesMs = findTranscriptMtimesMs({ projectsDir, fs, nowMs });
    if (!isQuietWindow({ nowMs, transcriptMtimesMs, thresholdMs: QUIET_THRESHOLD_MS })) {
      console.error('[session-repo-sync] 直近書き込みセッションあり、スキップ');
      return;
    }

    const fetchResult = runGit(target, ['fetch', 'origin', 'main', '--quiet'], spawn);
    if (fetchResult.error || fetchResult.status !== 0) {
      console.error('[session-repo-sync] fetch失敗、スキップ');
      return;
    }

    const headResult = runGit(target, ['rev-parse', 'HEAD'], spawn);
    const targetResult = runGit(target, ['rev-parse', 'origin/main'], spawn);
    if (headResult.error || headResult.status !== 0 || targetResult.error || targetResult.status !== 0) {
      console.error('[session-repo-sync] SHA取得失敗、スキップ');
      return;
    }
    const headSha = headResult.stdout.trim();
    const targetSha = targetResult.stdout.trim();
    const action = planSyncAction({ headSha, targetSha });
    if (!action.needed) {
      console.error('[session-repo-sync] 既にorigin/mainと同期済み');
      return;
    }

    const checkoutResult = runGit(target, action.args, spawn);
    if (checkoutResult.error || checkoutResult.status !== 0) {
      console.error('[session-repo-sync] checkout失敗、スキップ');
      return;
    }

    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.appendFileSync(ledgerPath, `${JSON.stringify({
        ts: new Date(nowMs).toISOString(),
        hook: 'session-repo-sync',
        action: 'checkout',
        from: headSha,
        to: targetSha,
      })}\n`, 'utf8');
    } catch {
      console.error('[session-repo-sync] checkout成功、台帳追記失敗');
      return;
    }
    console.error('[session-repo-sync] origin/mainへcheckout完了');
  } catch {
    console.error('[session-repo-sync] 予期しないエラー、スキップ');
  }
}

if (isEntry(import.meta.url)) {
  main();
}
