#!/usr/bin/env node
// 監督の Claude が気づかず GLM に切り替わる事故を防ぐため、Z.ai 用環境変数は spawn する子プロセスだけに注入し、グローバル設定には書かない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnvValue } from './env-kv.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cwdIndex = args.indexOf('--cwd');
const modelIndex = args.indexOf('--model');
const cwd = path.resolve(cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd());
const model = modelIndex >= 0 && args[modelIndex + 1] ? args[modelIndex + 1] : 'glm-5.3';
const omitted = new Set();
if (dryRun) omitted.add(args.indexOf('--dry-run'));
for (const index of [cwdIndex, modelIndex]) if (index >= 0) { omitted.add(index); omitted.add(index + 1); }
const instruction = args.filter((_, index) => !omitted.has(index)).join(' ').trim();
if (!instruction) { console.error('使い方: node tools/glm-code.mjs "<指示>" [--cwd <path>] [--model <name>] [--dry-run]'); process.exitCode = 2; }

if (instruction) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const readLimit = (file, limit) => { try { return fs.readFileSync(file, 'utf8').slice(0, limit); } catch { return ''; } };
  const slug = cwd.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const projects = path.join(home, '.claude', 'projects');
  let memoryFile = path.join(projects, slug, 'memory', 'MEMORY.md');
  if (!fs.existsSync(memoryFile)) {
    const candidates = [];
    try {
      for (const project of fs.readdirSync(projects)) {
        const file = path.join(projects, project, 'memory', 'MEMORY.md');
        try { candidates.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch {}
      }
    } catch {}
    candidates.sort((a, b) => b.mtime - a.mtime);
    memoryFile = candidates[0]?.file || '';
  }
  const mainMemory = memoryFile ? readLimit(memoryFile, 8000) : '';
  const memoryDir = memoryFile ? path.dirname(memoryFile) : '';
  const terms = [...new Set((instruction.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []))];
  const related = [];
  if (memoryDir) {
    try {
      for (const name of fs.readdirSync(memoryDir)) {
        if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
        const body = readLimit(path.join(memoryDir, name), 12000);
        const header = body.split(/\r?\n/).filter((line) => /^(name|description)\s*:/i.test(line)).join(' ').toLowerCase();
        const score = terms.reduce((sum, term) => sum + (`${name.toLowerCase()} ${header}`.includes(term) ? 1 : 0), 0);
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
  if (dryRun) {
    console.log(prompt);
  } else {
    const key = readEnvValue(path.join(home, '.claude', 'zai.env'), 'ZAI_API_KEY');
    if (!key) {
      console.error('Z.ai GLM Coding Plan は未契約または未設定です: ~/.claude/zai.env に ZAI_API_KEY がありません。自動購入・課金は行いません。');
      process.exitCode = 3;
    } else {
      const started = Date.now();
      let outputChars = 0;
      const child = spawn('claude', ['-p', prompt, '--model', model], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: key },
      });
      child.stdout.on('data', (chunk) => { outputChars += chunk.length; process.stdout.write(chunk); });
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.on('error', (error) => { console.error(`claude CLI を起動できません: ${error.message}`); process.exitCode = 1; });
      child.on('close', (status) => {
        const secs = (Date.now() - started) / 1000;
        try {
          const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
          fs.mkdirSync(path.dirname(ledger), { recursive: true });
          const usage = { t: new Date().toISOString(), provider: 'glm', model, in: Math.ceil(prompt.length / 4), out: Math.ceil(outputChars / 4), secs: Number(secs.toFixed(3)) };
          fs.appendFileSync(ledger, `${JSON.stringify(usage)}\n`, 'utf8');
        } catch {}
        process.exitCode = status ?? 1;
      });
    }
  }
}
