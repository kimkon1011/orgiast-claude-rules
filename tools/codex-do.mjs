#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cwdIndex = args.indexOf('--cwd');
const cwd = path.resolve(cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd());
const omitted = new Set([dryRun ? args.indexOf('--dry-run') : -1, cwdIndex, cwdIndex + 1]);
const instruction = args.filter((_, index) => !omitted.has(index)).join(' ').trim();
if (!instruction) { console.error('使い方: node tools/codex-do.mjs "<指示>" [--cwd <path>] [--dry-run]'); process.exit(2); }

const home = process.env.ORGIAST_HOME || os.homedir();
const slug = cwd.replace(/[^a-z0-9]/gi, '-').toLowerCase();
const projects = path.join(home, '.claude', 'projects');
let memoryFile = path.join(projects, slug, 'memory', 'MEMORY.md');
if (!fs.existsSync(memoryFile)) {
  const candidates = [];
  try {
    for (const project of fs.readdirSync(projects)) {
      const candidate = path.join(projects, project, 'memory', 'MEMORY.md');
      try { candidates.push({ file: candidate, mtime: fs.statSync(candidate).mtimeMs }); } catch {}
    }
  } catch {}
  candidates.sort((a, b) => b.mtime - a.mtime);
  memoryFile = candidates[0]?.file || '';
}
const readLimit = (file, limit) => { try { return fs.readFileSync(file, 'utf8').slice(0, limit); } catch { return ''; } };
const mainMemory = memoryFile ? readLimit(memoryFile, 8000) : '';
const memoryDir = memoryFile ? path.dirname(memoryFile) : '';
const terms = [...new Set((instruction.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []))];
const related = [];
if (memoryDir) {
  try {
    for (const name of fs.readdirSync(memoryDir)) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
      const file = path.join(memoryDir, name);
      const body = readLimit(file, 12000);
      const header = body.split(/\r?\n/).filter((line) => /^(name|description)\s*:/i.test(line)).join(' ').toLowerCase();
      const haystack = `${name.toLowerCase()} ${header}`;
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      if (score) related.push({ name, score, body: body.slice(0, 4000) });
    }
  } catch {}
}
related.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
const claudeMd = readLimit(path.join(cwd, 'CLAUDE.md'), 6000);
const context = [];
if (mainMemory || related.length || claudeMd) {
  context.push('これは Claude(監督)が蓄積したコンテキスト。既存の失敗パターンを繰り返さないこと。');
  if (mainMemory) context.push(`\n## MEMORY.md\n${mainMemory}`);
  for (const item of related.slice(0, 3)) context.push(`\n## 関連 memory: ${item.name}\n${item.body}`);
  if (claudeMd) context.push(`\n## 対象プロジェクト CLAUDE.md\n${claudeMd}`);
}
const prompt = `${context.join('\n')}\n\n## 実装指示\n${instruction}`.trim();
if (dryRun) { console.log(prompt); process.exit(0); }

const started = Date.now();
function execute(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    let outputChars = 0;
    const child = spawn(command, commandArgs, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { outputChars += chunk.length; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    child.on('error', (error) => resolve({ status: null, error, outputChars }));
    child.on('close', (status) => resolve({ status, outputChars }));
    child.stdin.end(prompt);
  });
}
let result;
if (process.platform === 'win32') {
  result = await execute('wsl', ['-d', 'Ubuntu', '--cd', cwd, '--', 'codex', 'exec', '-']);
  if (result.error || result.status !== 0) result = await execute('codex', ['exec', '-'], { cwd });
} else {
  result = await execute('codex', ['exec', '-'], { cwd });
}
const secs = (Date.now() - started) / 1000;
spawnSync('git', ['-C', cwd, 'diff', '--stat'], { stdio: ['ignore', 'inherit', 'inherit'] });
try {
  const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const usage = { t: new Date().toISOString(), provider: 'codex', model: 'codex-cli', in: Math.ceil(prompt.length / 4), out: Math.ceil((result.outputChars || 0) / 4), secs: Number(secs.toFixed(3)) };
  fs.appendFileSync(ledger, `${JSON.stringify(usage)}\n`, 'utf8');
} catch {}
process.exit(result?.status ?? 1);
