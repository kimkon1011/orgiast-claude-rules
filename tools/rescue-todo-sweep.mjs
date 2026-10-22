#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRescueBranches } from './rescue-review-scan.mjs';

export const SWEEPABLE_STATUSES = ['covered', 'covered-in-main', 'duplicate', 'covered-by-branch', 'ignored-only'];

const TODO_RE = /^\s*(\d+)\.\s+\[ \]\s+rescue ブランチ\s+`?([^`\s]+)`?\s+に退避した変更のレビューが必要（(.+?);\s*([0-9a-f]{7,40})）/;

export function findRescueTodos(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  const todos = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trimStart().startsWith('~~') || line.includes('✅')) continue;
    const match = line.match(TODO_RE);
    if (!match) continue;
    todos.push({ lineIndex, line, number: match[1], branch: match[2], repo: match[3], sha: match[4] });
  }
  return todos;
}

export function sweepLines(text, scanResultsByBranch, { date } = {}) {
  const original = String(text);
  const parts = original.split(/(\r\n|\n|\r)/);
  const todos = findRescueTodos(original);
  const swept = [];
  const kept = [];
  const statusByBranch = scanResultsByBranch instanceof Map
    ? scanResultsByBranch
    : new Map(Object.entries(scanResultsByBranch || {}));
  for (const todo of todos) {
    const result = statusByBranch.get(todo.branch);
    const status = typeof result === 'string' ? result : result?.status;
    if (!SWEEPABLE_STATUSES.includes(status)) {
      kept.push(todo.branch);
      continue;
    }
    const body = todo.line.replace(/^\s*\d+\.\s+\[ \]\s+/, '');
    parts[todo.lineIndex * 2] = `${todo.number}. ~~${body}~~ → ✅ ${date} rescue-review-scan: ${status}（main に取り込み済み・マージ不要）`;
    swept.push({ branch: todo.branch, status });
  }
  const output = parts.join('');
  return { text: output, swept, kept, changed: output !== original };
}

export function sweepFile(file, {
  date = new Date().toISOString().slice(0, 10),
  main = 'origin/main',
  dryRun = false,
  readFile = (name) => fs.readFileSync(name, 'utf8'),
  writeFile = (name, text) => fs.writeFileSync(name, text),
  isDirectory = (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
  scan = scanRescueBranches,
  scanRescueBranches: injectedScan,
  warn = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const input = readFile(file);
  const todos = findRescueTodos(input);
  const byRepo = new Map();
  for (const todo of todos) {
    if (!byRepo.has(todo.repo)) byRepo.set(todo.repo, []);
    byRepo.get(todo.repo).push(todo);
  }
  const resultsByBranch = new Map();
  for (const [repo, repoTodos] of byRepo) {
    try {
      if (!isDirectory(repo)) throw new Error('repo ディレクトリが存在しません');
      const results = (injectedScan || scan)({ repo, main });
      const wanted = new Set(repoTodos.map(todo => todo.branch));
      for (const result of results) {
        const localName = result.branch.startsWith('origin/') ? result.branch.slice(7) : result.branch;
        if (wanted.has(result.branch)) resultsByBranch.set(result.branch, result);
        if (wanted.has(localName)) resultsByBranch.set(localName, result);
      }
    } catch (error) {
      warn(`[rescue-todo-sweep] ${repo}: ${error?.message ?? error}`);
    }
  }
  const result = sweepLines(input, resultsByBranch, { date });
  if (result.changed && !dryRun) writeFile(file, result.text);
  return { file, swept: result.swept, kept: result.kept, changed: result.changed };
}

function parseArgs(argv) {
  const opts = { home: os.homedir(), dryRun: false, json: false, date: new Date().toISOString().slice(0, 10), main: 'origin/main' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home') opts.home = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--main') opts.main = argv[++i];
  }
  return opts;
}

function run(argv) {
  const opts = parseArgs(argv);
  const file = path.join(opts.home, '.claude', 'next-session.md');
  const result = sweepFile(file, opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`rescue-todo-sweep: swept ${result.swept.length}, kept ${result.kept.length}${opts.dryRun ? ' (dry-run)' : ''}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMainModule()) run(process.argv.slice(2));
