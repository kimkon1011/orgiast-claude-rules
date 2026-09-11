#!/usr/bin/env node
// 安い provider の設定は spawn する子プロセスだけに注入する。process.env や Claude の設定ファイルは変更しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { providerResetUntil, providerInCooldown } from './codex-cooldown.mjs';
import { isUnspawnable, resolveClaudeExecutableFromDisk } from './claude-exe.mjs';

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const COOLDOWN_FILE = () => path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'provider-cooldown.json');

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
  // 親から継承した Anthropic の鍵は安いレーンの子に渡さない(認証が二重に立ち、
  // 子が「connectors を無効化した」と警告する。2026-09-10 実測)。
  delete env.ANTHROPIC_API_KEY;
  if (config.maxContextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(config.maxContextTokens);
  return env;
}

export function readInstruction(promptFile, positional) {
  if (!promptFile) return positional.join(' ').trim();
  return fs.readFileSync(promptFile, 'utf8').trim();
}

// ---- 仕様C2b: 定額レーン飽和(usage limit)の検知と cooldown ----

// 子プロセスの出力に「契約枠を使い切った」系の文言が含まれるかを判定する。
export function detectUsageLimitText(text) {
  return /usage\s+limit\s+reached|429|\[1308\]/i.test(String(text || ''));
}

export function detectBillingFailure(text) {
  const value = String(text || '');
  if (/402|insufficient\s+balance/i.test(value)) return 402;
  if (/429|usage\s+limit/i.test(value)) return 429;
  return null;
}

export function appendUsageLedger({ home, provider, model, promptChars, outputChars, secs, ok, status = null, now = new Date() }) {
  const file = path.join(home, '.claude', 'executor-usage.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { t: now.toISOString(), provider, model, in: Math.ceil(promptChars / 4), out: Math.ceil(outputChars / 4), secs: Number(secs.toFixed(3)), ok };
  if (status !== null) row.status = status;
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

// usage-limit 本文から provider の再開時刻を返す。取れなければ +5h。
export function cooldownUntilFromText(text, now = Date.now()) {
  return providerResetUntil(text, now, FIVE_HOURS);
}

export function readProviderCooldown(claudeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(claudeDir, 'provider-cooldown.json'), 'utf8')); } catch { return {}; }
}

// provider-cooldown.json に usage_limit を記録する(codex と並ぶ構造。理由・記録時刻付き)。
// 24h の到達回数を後から数えられるよう、provider-limit-history.jsonl にも1行残す。
export function writeProviderCooldown({ claudeDir, provider, until, reason = 'usage_limit', now = Date.now() }) {
  const name = String(provider || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) return { file: null, provider: name, changed: false };
  const state = readProviderCooldown(claudeDir);
  const changed = Number(state?.[name]?.until) !== Number(until);
  state[name] = { until: Number(until), reason: String(reason), at: new Date(now).toISOString() };
  const file = path.join(claudeDir, 'provider-cooldown.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (/^usage_limit/.test(String(reason))) {
    try {
      fs.appendFileSync(path.join(claudeDir, 'provider-limit-history.jsonl'), `${JSON.stringify({ t: new Date(now).toISOString(), provider: name, until: Number(until), reason: String(reason) })}\n`, 'utf8');
    } catch {}
  }
  return { file, provider: name, changed };
}

function hasZaiKey(home) {
  if (process.env.ZAI_API_KEY) return true;
  return Boolean(readEnvValue(path.join(home, '.claude', 'zai.env'), 'ZAI_API_KEY'));
}

// --provider auto: クールダウン中でない glm → deepseek。zai キーが無い機体は deepseek のみ。
export function autoProvider({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now() } = {}) {
  const claudeDir = path.join(home, '.claude');
  if (hasZaiKey(home) && !providerInCooldown('glm', now, path.join(claudeDir, 'provider-cooldown.json'))) return 'glm';
  if (providerInCooldown('deepseek', now, path.join(claudeDir, 'provider-cooldown.json')) && hasZaiKey(home)) return 'glm';
  return 'deepseek';
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
  const usage = '使い方: node tools/cheap-code.mjs [--provider deepseek|glm|auto] [--model <名前>] [--prompt-file <path>] [--cwd <path>] [--dry-run] "<指示>"';
  let parsed;
  let config;
  let instruction;
  try {
    parsed = parseArgs(args);
    instruction = readInstruction(parsed.promptFile, parsed.positional);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  if (!instruction) { console.error(usage); return 2; }

  const cwd = path.resolve(parsed.cwd);
  const home = process.env.ORGIAST_HOME || os.homedir();
  let providerName = parsed.provider;
  if (providerName === 'auto') {
    providerName = autoProvider({ home });
    console.error(`[cheap-code] provider=auto → ${providerName}`);
  }
  try {
    config = resolveProvider(providerName);
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  const model = parsed.model || config.defaultModel;
  const key = readEnvValue(path.join(home, '.claude', config.envFile), config.keyName);
  const prompt = `[headless:cheap-code]\n${buildPrompt(instruction, cwd, home)}`;
  const childArgs = ['-p', prompt, '--model', model];
  if (parsed.dryRun) {
    console.log(JSON.stringify({ provider: config.provider, base: config.base, model, keyPresent: Boolean(key), argv: ['claude', ...childArgs] }, null, 2));
    return 0;
  }
  if (!key) {
    console.error(`${config.provider} のキーが未設定です: ~/.claude/${config.envFile} に ${config.keyName} がありません。自動購入・課金は行いません。`);
    return 3;
  }
  const cooldownFile = path.join(home, '.claude', 'provider-cooldown.json');
  if (providerInCooldown(config.provider, Date.now(), cooldownFile)) {
    try { appendUsageLedger({ home, provider: config.provider, model, promptChars: prompt.length, outputChars: 0, secs: 0, ok: false, status: 'cooldown' }); } catch {}
    const until = readProviderCooldown(path.join(home, '.claude'))[config.provider]?.until;
    const untilText = Number.isFinite(Number(until)) ? `(${new Date(Number(until)).toISOString()}まで)` : '';
    console.error(`[cheap-code] ${config.provider} はクールダウン中です${untilText}。起動を省略しました。`);
    return 3;
  }

  // PATH 上の claude は Windows では claude.bat で、Node は shell 無しに .bat を起動できない
  // (2026-09-10 実測: spawn claude ENOENT で無人ジョブが毎晩落ちていた)。exe の絶対パスを解決する。
  const { executable, candidates } = await resolveClaudeExecutableFromDisk(process);
  if (executable === 'claude' && process.platform === 'win32') {
    console.error('[cheap-code] claude.exe が見つかりません(候補0件)。CLAUDE_CLI に claude.exe の絶対パスを設定してください。');
    return 4;
  }
  if (isUnspawnable(executable, process.platform)) {
    console.error(`[cheap-code] ${executable} は shell 無しで起動できません(.bat/.cmd)。CLAUDE_CLI に claude.exe を指定してください。`);
    return 4;
  }

  const started = Date.now();
  let outputChars = 0;
  let stdoutText = '';
  let stderrText = '';
  const status = await new Promise((resolve) => {
    const child = spawn(executable, childArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...buildChildEnv(config, key), ORGIAST_HEADLESS_JOB: `cheap-code:${config.provider}` },
    });
    child.stdout.on('data', (chunk) => { outputChars += chunk.length; stdoutText += String(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderrText += String(chunk); process.stderr.write(chunk); });
    child.on('error', (error) => { console.error(`claude CLI を起動できません: ${error.message}`); resolve(1); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const secs = (Date.now() - started) / 1000;

  // 定額レーン飽和(codex/glm の usage limit)は「契約枠なし」として cooldown を書き exit 3 で返す。
  // 成功(exit 0)のまま 429 文言が混ざることはないので、失敗時にだけ検査する。
  const failureCode = status !== 0 ? detectBillingFailure(`${stdoutText}\n${stderrText}`) : null;
  if (failureCode) {
    const until = failureCode === 402 ? Date.now() + 24 * 60 * 60 * 1000 : cooldownUntilFromText(`${stdoutText}\n${stderrText}`, Date.now());
    try {
      appendUsageLedger({ home, provider: config.provider, model, promptChars: prompt.length, outputChars, secs, ok: false, status: failureCode });
      writeProviderCooldown({ claudeDir: path.join(home, '.claude'), provider: config.provider, until, reason: failureCode === 402 ? 'http_402' : 'usage_limit' });
      console.error(`[cheap-code] ${config.provider} は利用不可(${failureCode})。provider-cooldown.json に ${new Date(until).toISOString()} まで記録しました。`);
    } catch (error) {
      console.error(`[cheap-code] cooldown 記録に失敗: ${String(error?.message ?? error)}`);
    }
    return 3;
  }
  try {
    appendUsageLedger({ home, provider: config.provider, model, promptChars: prompt.length, outputChars, secs, ok: status === 0, status: status === 0 ? null : status });
  } catch {}
  return status;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
