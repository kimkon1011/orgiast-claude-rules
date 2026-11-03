#!/usr/bin/env node
// 安い provider の設定は spawn する子プロセスだけに注入する。process.env や Claude の設定ファイルは変更しない。
import { OPENROUTER_ANTHROPIC_BASE, GATEWAY_MODELS, gatewayModel } from './provider-routing.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';
import { providerResetUntil, providerInCooldown } from './codex-cooldown.mjs';
import {
  isUnspawnable,
  listStrippedClaudeChildEnvKeys,
  prepareWorkerConfigDir,
  resolveClaudeExecutableFromDisk,
  sanitizeClaudeChildEnv,
} from './claude-exe.mjs';

const FIVE_HOURS = 5 * 60 * 60 * 1000;

// claude.exe の解決は claude-exe.mjs に一本化する。以前はここに探索の重複実装
// (resolveClaudeBin) があり、%APPDATA%\Claude\claude-code を見落として
// 「claude.exe が見つかりません」で止まっていた(2026-10-17 実測)。
const COOLDOWN_FILE = () => path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'provider-cooldown.json');

const PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    provider: 'deepseek',
    base: OPENROUTER_ANTHROPIC_BASE,
    envFile: 'openrouter.env',
    keyName: 'OPENROUTER_API_KEY',
    // OpenRouter のモデル名を使い、既定の推論ありを維持する。
    // 高品質が要るときだけ --model deepseek-v4-pro。
    defaultModel: GATEWAY_MODELS.deepseek,
    billingProvider: 'openrouter',
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

// 子 CLI の API 応答ヘッダ待ちの上限。既定の 600s だと API が無応答のまま 600s ハングし、
// 900s の cap 内で再試行に入れず timeout になる(delegation-health fallback_chain_timeout)。
// 短縮するとハング時に SDK 再試行へ早く回れる(識別実験: 5000ms 指定で 5s ごとに再送を確認)。
export const DEFAULT_CHILD_API_TIMEOUT_MS = 240000;

export function resolveChildApiTimeoutMs(parentEnv = process.env) {
  const value = Number(parentEnv.CHEAP_CODE_API_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CHILD_API_TIMEOUT_MS;
}

export function buildChildEnv(config, key, parentEnv = process.env, { configDir } = {}) {
  // 先に親 env を浄化する。デスクトップ版 Claude から呼ばれると CLAUDECODE / CLAUDE_CODE_* /
  // CLAUDE_AGENT_SDK_* / MCP_* / ANTHROPIC_* が子へ漏れ、DeepSeek の Anthropic 互換 API が
  // `400 Invalid schema for function 'Artifact'` で落ちる(2026-10-17 実測)。
  const env = sanitizeClaudeChildEnv(parentEnv);
  // 浄化した後に provider の接続値を入れる(順序を逆にすると親の ANTHROPIC_* が残る)。
  env.ANTHROPIC_BASE_URL = config.base;
  env.ANTHROPIC_AUTH_TOKEN = key;
  // 親から継承した Anthropic の鍵は安いレーンの子に渡さない(認証が二重に立ち、
  // 子が「connectors を無効化した」と警告する。2026-09-10 実測)。
  if (config.billingProvider === 'openrouter') {
    env.ANTHROPIC_API_KEY = '';
    for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) env[name] = config.defaultModel;
  }
  else delete env.ANTHROPIC_API_KEY;
  if (config.maxContextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(config.maxContextTokens);
  // 契約 RULES「他バックエンドの挙動を変えない」に従い、delegation-health が観測した
  // backend=cheap-code:deepseek に限定する(glm は既定のまま。必要になったら別途実測して広げる)。
  if (config.provider === 'deepseek') env.API_TIMEOUT_MS = String(resolveChildApiTimeoutMs(parentEnv));
  // 委譲先は監督ではなく実行役なので、全社 hook を読まない専用の設定ディレクトリを渡す。
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
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
  const options = { provider: 'deepseek', model: '', cwd: process.cwd(), promptFile: '', dryRun: false, help: false };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    // --help は「使い方を見たい」という正常な要求。不明オプションとして弾くと exit 2 になり、
    // 指示文として解釈させると有料セッションが起動する(2026-10-15 実測)。
    if (arg === '-h' || arg === '--help') { options.help = true; continue; }
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
  if (!instruction) {
    // --help 単独なら正常終了(0)として使い方を stdout に出す。指示文が併記されているときは
    // help を無視して通常実行する(「--help を実装して」等の指示を乗っ取らないため)。
    (parsed.help ? console.log : console.error)(usage);
    return parsed.help ? 0 : 2;
  }

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
  const model = gatewayModel(providerName, parsed.model || config.defaultModel);
  const billingProvider = config.billingProvider || config.provider;
  const key = process.env[config.keyName] || readEnvValue(path.join(home, '.claude', config.envFile), config.keyName);
  const prompt = `[headless:cheap-code]\n${buildPrompt(instruction, cwd, home)}`;
  // 実行役の子に渡す専用設定ディレクトリ。settings.json は毎回作り直す(古い deny を残さない)。
  const configDir = prepareWorkerConfigDir({ home });
  // プロンプトは stdin で渡す。CLI 引数だと Windows のコマンドライン長上限で spawn ENAMETOOLONG になる (2026-09-21 実測)。
  const childArgs = ['-p', '--model', model];
  if (parsed.dryRun) {
    console.log(JSON.stringify({
      provider: config.provider,
      base: config.base,
      model,
      keyPresent: Boolean(key),
      argv: ['claude', ...childArgs],
      promptVia: 'stdin',
      promptChars: prompt.length,
      configDir,
      strippedEnv: listStrippedClaudeChildEnvKeys(process.env),
    }, null, 2));
    return 0;
  }
  if (!key) {
    console.error(`${config.provider} のキーが未設定です: ~/.claude/${config.envFile} に ${config.keyName} がありません。自動購入・課金は行いません。`);
    return 3;
  }
  const cooldownFile = path.join(home, '.claude', 'provider-cooldown.json');
  if (providerInCooldown(billingProvider, Date.now(), cooldownFile)) {
    try { appendUsageLedger({ home, provider: billingProvider, model, promptChars: prompt.length, outputChars: 0, secs: 0, ok: false, status: 'cooldown' }); } catch {}
    const until = readProviderCooldown(path.join(home, '.claude'))[billingProvider]?.until;
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

  console.error(`[${billingProvider}:${model}]`);
  const started = Date.now();
  let outputChars = 0;
  let stdoutText = '';
  let stderrText = '';
  const status = await new Promise((resolve) => {
    const child = spawn(executable, childArgs, { windowsHide: true,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...buildChildEnv({ ...config, defaultModel: model }, key, process.env, { configDir }), ORGIAST_HEADLESS_JOB: `cheap-code:${config.provider}` },
    });
    child.stdin.on('error', () => {});   // 子が先に死んだときの EPIPE で親を落とさない
    child.stdin.end(prompt);
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
      appendUsageLedger({ home, provider: billingProvider, model, promptChars: prompt.length, outputChars, secs, ok: false, status: failureCode });
      writeProviderCooldown({ claudeDir: path.join(home, '.claude'), provider: billingProvider, until, reason: failureCode === 402 ? 'http_402' : 'usage_limit' });
      console.error(`[cheap-code] ${config.provider} は利用不可(${failureCode})。provider-cooldown.json に ${new Date(until).toISOString()} まで記録しました。`);
    } catch (error) {
      console.error(`[cheap-code] cooldown 記録に失敗: ${String(error?.message ?? error)}`);
    }
    return 3;
  }
  try {
    appendUsageLedger({ home, provider: billingProvider, model, promptChars: prompt.length, outputChars, secs, ok: status === 0, status: status === 0 ? null : status });
  } catch {}
  return status;
}

if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
