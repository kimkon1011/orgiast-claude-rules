#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const VERSION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXCLUDED = new Set(['node_modules', '.git', '.next', 'AppData', 'Library', 'Windows', 'Program Files', '$Recycle.Bin', '.venv', 'dist', 'build']);

function repoRootFor(listingsDir) {
  const candidates = [];
  let current = listingsDir;
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, '.git'))) || candidates[0];
}

function uniqueExisting(paths) {
  const seen = new Set();
  return paths.filter((candidate) => {
    if (typeof candidate !== 'string') return false;
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return false;
    seen.add(resolved);
    return true;
  }).map((candidate) => path.resolve(candidate));
}

function cwdFromJsonl(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.toString('utf8', 0, bytes);
    const match = head.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!match) return undefined;
    return JSON.parse(`"${match[1]}"`);
  } catch { return undefined; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

export function knownProjectRoots(home) {
  const candidates = [];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    if (config?.projects && typeof config.projects === 'object') candidates.push(...Object.keys(config.projects));
  } catch {}
  try {
    const projectsDir = path.join(home, '.claude', 'projects');
    for (const slug of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      let files;
      try { files = fs.readdirSync(path.join(projectsDir, slug.name)).filter((name) => name.endsWith('.jsonl')); } catch { continue; }
      for (const name of files) {
        const cwd = cwdFromJsonl(path.join(projectsDir, slug.name, name));
        if (cwd) { candidates.push(cwd); break; }
      }
    }
  } catch {}
  return uniqueExisting(candidates);
}

export function detectHostRepo({ roots, priorityRoots = [], previousState, budgetMs = 4000, rootBudgetMs = 1500, giveUpAfter = 3, now = Date.now(), clock = Date.now, onRootStart }) {
  const checkedAtMs = new Date(now).getTime();
  const started = clock();
  const deadline = started + Math.max(0, Number(budgetMs) || 0);
  const priority = new Set(priorityRoots.map((root) => path.resolve(root)));
  const allRoots = uniqueExisting([...priorityRoots, ...roots]);
  const scanned = new Set((previousState?.scannedRoots || []).map((root) => path.resolve(root)).filter((root) => allRoots.includes(root)));
  const giveUp = new Set((previousState?.giveUpRoots || []).map((root) => path.resolve(root)).filter((root) => allRoots.includes(root)));
  const cutoffCounts = { ...(previousState?.cutoffCounts || {}) };
  let globalTimedOut = false;

  function walk(directory, depth, maxDepth, rootDeadline) {
    if (clock() >= deadline) { globalTimedOut = true; return { cutoff: true }; }
    if (clock() >= rootDeadline) return { cutoff: true };
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return {}; }
    if (path.basename(directory) === 'listings' && path.basename(path.dirname(directory)) === 'v1' && path.basename(path.dirname(path.dirname(directory))) === 'api') {
      const repoPath = repoRootFor(directory);
      if (repoPath) return { repoPath };
    }
    if (depth >= maxDepth) return {};
    for (const entry of entries) {
      if (!entry.isDirectory() || EXCLUDED.has(entry.name)) continue;
      const result = walk(path.join(directory, entry.name), depth + 1, maxDepth, rootDeadline);
      if (result.repoPath || result.cutoff) return result;
    }
    return {};
  }

  for (const root of allRoots) {
    if (scanned.has(root) || giveUp.has(root)) continue;
    if (clock() >= deadline) { globalTimedOut = true; break; }
    onRootStart?.(root);
    const rootDeadline = Math.min(deadline, clock() + Math.max(0, Number(rootBudgetMs) || 0));
    const result = walk(root, 0, priority.has(root) ? 4 : 6, rootDeadline);
    if (result.repoPath) return {
      checkedAt: new Date(checkedAtMs).toISOString(), status: 'found', repoPath: result.repoPath,
      scannedRoots: [...scanned], pendingRoots: allRoots.filter((item) => !scanned.has(item) && !giveUp.has(item)), giveUpRoots: [...giveUp], cutoffCounts, version: VERSION,
    };
    if (result.cutoff) {
      cutoffCounts[root] = (Number(cutoffCounts[root]) || 0) + 1;
      if (cutoffCounts[root] >= giveUpAfter) giveUp.add(root);
      if (globalTimedOut) break;
    } else {
      scanned.add(root);
      delete cutoffCounts[root];
    }
  }

  const pendingRoots = allRoots.filter((root) => !scanned.has(root) && !giveUp.has(root));
  const complete = pendingRoots.length === 0;
  return {
    checkedAt: new Date(checkedAtMs).toISOString(),
    status: complete && giveUp.size === 0 ? 'absent' : 'unknown',
    scannedRoots: [...scanned], pendingRoots, giveUpRoots: [...giveUp], cutoffCounts, version: VERSION,
  };
}

export function formatDetectMessage(state, pendingCount) {
  if (state?.status !== 'found') return '';
  const instruction = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'makimono-auto-approve.md');
  // 自動承認そのものは 2026-08-28 に実装・本番反映済み。ここで「実行してください」と言うと
  // 同じPCが毎セッション作り直しに走るので、残作業(§6)だけを指すこと。
  const lines = [`[マキモノ] このPCに本体リポがあります: ${state.repoPath}`, `${instruction} の状態を確認し、未了の残作業(§6・§7)だけ実行してください。§1〜§3 は実装済みなので作り直さないこと。`];
  if (Number.isInteger(pendingCount)) lines.push(`現在の審査待ち: ${pendingCount}件`);
  return lines.join('\n');
}

export function defaultRoots(home) {
  const roots = [home, ...['Downloads', 'Documents', 'Projects', 'projects', 'src', 'repos', 'ghq', 'dev', 'work', 'code'].map((name) => path.join(home, name))];
  if (process.platform === 'win32') roots.push('D:\\', 'E:\\');
  return uniqueExisting(roots);
}

function pendingCount(home) {
  try {
    const logs = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'makimono-submissions.json'), 'utf8'));
    return Array.isArray(logs) ? logs.filter((entry) => entry?.status !== 'published').length : undefined;
  } catch { return undefined; }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const home = process.env.ORGIAST_HOME || os.homedir();
    const cacheFile = path.join(home, '.claude', 'makimono-host-detect.json');
    const now = Date.now();
    const priorityRoots = knownProjectRoots(home);
    const roots = defaultRoots(home);
    const currentRoots = uniqueExisting([...priorityRoots, ...roots]);
    let cached;
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    let state;
    if (!args.includes('--force') && cached?.version === VERSION && cached.status !== 'unknown') {
      const ttl = 7 * DAY_MS;
      const cachedRoots = new Set([...(cached.scannedRoots || []), ...(cached.pendingRoots || []), ...(cached.giveUpRoots || [])].map((root) => path.resolve(root)));
      const rootsUnchanged = currentRoots.every((root) => cachedRoots.has(root));
      if (rootsUnchanged && now - new Date(cached.checkedAt).getTime() < ttl) state = cached;
    }
    if (!state) {
      state = detectHostRepo({
        roots, priorityRoots,
        previousState: args.includes('--force') ? undefined : cached?.version === VERSION ? cached : undefined,
        budgetMs: Number(process.env.MAKIMONO_DETECT_BUDGET_MS ?? 4000),
        rootBudgetMs: Number(process.env.MAKIMONO_DETECT_ROOT_BUDGET_MS ?? 1500), now,
      });
      try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, `${JSON.stringify(state, null, 2)}\n`); } catch {}
    }
    if (args.includes('--json')) console.log(JSON.stringify(state));
    else {
      const message = formatDetectMessage(state, pendingCount(home));
      if (message) console.log(message);
    }
  } catch {}
}

if (isEntry(import.meta.url)) await main().catch(() => {});
