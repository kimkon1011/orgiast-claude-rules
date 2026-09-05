#!/usr/bin/env node
// 安い provider の設定は spawn する子プロセスだけに注入する。process.env や Claude の設定ファイルは変更しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

const PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    provider: 'deepseek',
    base: 'https://api.deepseek.com/anthropic',
    envFile: 'deepseek.env',
    keyName: 'DEEPSEEK_API_KEY',
    // 別名 deepseek-chat ではなく実モデル名を既定にする(別名は将来どの世代に張り替わるか読めない)。
    // 高品質が要るときだけ --model deepseek-v4-pro。
    defaultModel: 'deepseek-v4-flash',
    // Claude Code のモデルカタログに無い名前だと窓を 200k と仮定して早期に auto-compact する。
    // DeepSeek v4 系は実測 1M なので明示する(公式 pricing: context 1M / max output 384K)。
    maxContextTokens: 1000000,
  }),
  glm: Object.freeze({
    provider: 'glm',
    base: 'https://api.z.ai/api/anthropic',
    envFile: 'zai.env',
    keyName: 'ZAI_API_KEY',
    defaultModel: 'glm-5.3',
    // GLM-5.3 は公式ドキュメントで context 1M / max output 128K。
    // 明示しないとカタログ外モデル扱いで窓を 200k と仮定され、早期に auto-compact される。
    maxContextTokens: 1000000,
  }),
});

export function resolveProvider(name = 'deepseek') {
  const config = PROVIDERS[name];
  if (!config) throw new Error(`不正な provider です: ${name} (deepseek または glm を指定してください)`);
  return config;
}

export function buildChildEnv(config, key, parentEnv = process.env) {
  const env = { ...parentEnv, ANTHROPIC_BASE_URL: config.base, ANTHROPIC_AUTH_TOKEN: key };
  if (config.maxContextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(config.maxContextTokens);
  return env;
}

export function readInstruction(promptFile, positional) {
  if (!promptFile) return positional.join(' ').trim();
  return fs.readFileSync(promptFile, 'utf8').trim();
}

function parseArgs(args) {
  const options = { provider: 'deepseek', model: '', cwd: process.cwd(), promptFile: '', dryRun: false };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (['--provider', '--model', '--cwd', '--prompt-file'].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} に値が必要です`);
      if (arg === '--provider') options.provider = value;
      if (arg === '--model') options.model = value;
      if (arg === '--cwd') options.cwd = value;
      if (arg === '--prompt-file') options.promptFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`不明なオプションです: ${arg}`);
    positional.push(arg);
  }
  return { ...options, positional };
}

function buildPrompt(instruction, cwd, home) {
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
  return `${context.join('\n')}\n\n## 実装指示\n${instruction}`.trim();
}

async function main(args) {
  const usage = '使い方: node tools/cheap-code.mjs [--provider deepseek|glm] [--model <名前>] [--prompt-file <path>] [--cwd <path>] [--dry-run] "<指示>"';
  let parsed;
  let config;
  let instruction;
  try {
    parsed = parseArgs(args);
    config = resolveProvider(parsed.provider);
    instruction = readInstruction(parsed.promptFile, parsed.positional);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  if (!instruction) { console.error(usage); return 2; }

  const cwd = path.resolve(parsed.cwd);
  const home = process.env.ORGIAST_HOME || os.homedir();
  const model = parsed.model || config.defaultModel;
  const key = readEnvValue(path.join(home, '.claude', config.envFile), config.keyName);
  const prompt = buildPrompt(instruction, cwd, home);
  const childArgs = ['-p', prompt, '--model', model];
  if (parsed.dryRun) {
    console.log(JSON.stringify({ provider: config.provider, base: config.base, model, keyPresent: Boolean(key), argv: ['claude', ...childArgs] }, null, 2));
    return 0;
  }
  if (!key) {
    console.error(`${config.provider} のキーが未設定です: ~/.claude/${config.envFile} に ${config.keyName} がありません。自動購入・課金は行いません。`);
    return 3;
  }

  const started = Date.now();
  let outputChars = 0;
  const status = await new Promise((resolve) => {
    const child = spawn('claude', childArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildChildEnv(config, key),
    });
    child.stdout.on('data', (chunk) => { outputChars += chunk.length; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (error) => { console.error(`claude CLI を起動できません: ${error.message}`); resolve(1); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const secs = (Date.now() - started) / 1000;
  try {
    const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    const usageEntry = { t: new Date().toISOString(), provider: config.provider, model, in: Math.ceil(prompt.length / 4), out: Math.ceil(outputChars / 4), secs: Number(secs.toFixed(3)) };
    fs.appendFileSync(ledger, `${JSON.stringify(usageEntry)}\n`, 'utf8');
  } catch {}
  return status;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
