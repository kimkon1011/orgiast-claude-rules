#!/usr/bin/env node
// 通常実装は Sol、長時間・高難度・auto の失敗時は Astra（既定 effort high）。
// --lane sol|astra|auto / --model astra|sol|<slug> / --effort で指定する。
// 先頭40行の <!-- lane: astra --> でも指定可。Astra 上限時は Sol へ退避する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { parseCodexResetUntil, providerCooldownMs, writeCodexCooldown } from './codex-cooldown.mjs';

// Windows の shell 経由起動では引数がクォートされないため、この値に空白を入れると
// -p の値が割れて Gemini が使い方(ヘルプ)を出して終わる。空白を入れないこと。
export const GEMINI_PROMPT_FLAG = 'Execute_the_implementation_instructions_provided_on_stdin.';

const ASTRA = 'gpt-6-astra';
const SOL = 'gpt-5.6-sol';
export function normalizeCodexModel(model) {
  return model === 'astra' ? ASTRA : model === 'sol' ? SOL : model;
}

// I/O を持たない判定。クールダウン残時間は呼び出し側で読み取って注入する。
export function decideCodexLane({ lane = 'auto', model, promptText = '', timeoutSecs = 1800, review = false, astraCooldownMs = 0 } = {}) {
  let slug = SOL, reason = 'default_sol';
  if (model) { slug = normalizeCodexModel(model); reason = 'explicit_model'; }
  else if (lane !== 'auto') { slug = lane === 'astra' ? ASTRA : SOL; reason = `lane_${lane}`; }
  else {
    const header = String(promptText).split(/\r?\n/).slice(0, 40).join('\n');
    const marker = header.match(/<!--\s*lane:\s*(astra|sol)\s*-->|^Lane:\s*(astra|sol)\s*$/im);
    if (marker) { const selected = marker[1] || marker[2]; slug = selected.toLowerCase() === 'astra' ? ASTRA : SOL; reason = `header_${selected.toLowerCase()}`; }
    else if (review) reason = 'review_sol';
    else if (timeoutSecs >= 2700) { slug = ASTRA; reason = 'long_timeout'; }
    else {
      const keywords = /マイグレーション|migration|E2E|Playwright|リファクタ|refactor|横断|全ファイル|複数リポ|調査して実装|根本原因/gi;
      if (new Set((String(promptText).match(keywords) || []).map((word) => word.toLowerCase())).size >= 2) {
        slug = ASTRA; reason = 'complex_task';
      }
    }
  }
  if (slug === ASTRA && !model && astraCooldownMs > 0) { slug = SOL; reason = `astra_cooldown:${reason}`; }
  return { slug, effort: slug === ASTRA ? 'high' : undefined, reason };
}

export function buildCodexExecArgs({ slug = SOL, effort, review = false } = {}) {
  return ['exec', '-m', slug, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-s', review ? 'read-only' : 'workspace-write', '-'];
}

export function needsWorktreeRepair(gitFileContent) {
  return /^gitdir:\s*[A-Za-z]:/i.test(String(gitFileContent ?? '').trim());
}

export function detectQuotaLimit(stdout, stderr, exitStatus = null, promptText = '') {
  void exitStatus;
  const stdoutText = String(stdout || '');
  const prompt = String(promptText || '');
  const sources = [
    { text: stdoutText, offset: 0 },
    { text: String(stderr || ''), offset: stdoutText.length + 1 },
  ];
  const prefixed = /^\s*(?:\[[^\]]*\]\s*)?(?:ERROR|Error|error|WARN(?:ING)?)\s*[:\-]?\s*(You(?:'ve| have) hit your usage limit|Usage limit (?:reached|exceeded)|Rate limit (?:reached|exceeded)|Too many requests|Upgrade to Pro)/;
  const raw = /^(You've hit your usage limit|Too many requests)/i;
  // コロン隣接の 429 は grep -h / sed などが出力した行番号とみなす。
  const status429 = /^\s*(?:\[[^\]]*\]\s*)?(?:ERROR|Error|error|WARN(?:ING)?)?\s*[:\-]?\s*(?:HTTP\s*)?429(?!:)\b/i;
  const ignoredPrefix = /^(?:✔|✓|✖|×|ok\s|not ok\s|#)/i;
  const codeLike = /(?:;|\{|\}|=>|\breturn\s|assert|regex|\/i)/i;

  for (const source of sources) {
    let position = 0;
    for (const line of source.text.split(/\r?\n/)) {
      const trimmed = line.trim();
      let match = line.match(prefixed);
      let pattern;
      if (match) {
        const message = match[1];
        pattern = /you/i.test(message) ? "You've hit your usage limit"
          : /usage/i.test(message) ? 'usage limit'
          : /rate/i.test(message) ? 'rate limit'
          : /too many/i.test(message) ? 'too many requests'
          : 'Upgrade to Pro';
      } else if ((match = trimmed.match(raw))) {
        pattern = /usage/i.test(match[1]) ? "You've hit your usage limit" : 'too many requests';
      } else if (status429.test(line) && /(?:too many requests|rate|limit|quota)/i.test(line)) {
        match = line.match(/(?:HTTP\s*)?429\b/i);
        pattern = '429';
      }
      if (match && !prompt.includes(trimmed) && !ignoredPrefix.test(trimmed) && !codeLike.test(trimmed)) {
        return {
          matched: true,
          pattern,
          index: source.offset + position + Math.max(0, line.indexOf(match[0])),
          snippet: trimmed,
        };
      }
      position += line.length + 1;
    }
  }
  return { matched: false };
}

export function shouldFlagEmptyFallbackDiff({ executorName, wantedEdit, timedOut, diffText }) {
  // diffText は spawnSync の stdout。spawn に失敗すると null が来るので String() で畳む
  // (ここで例外を投げると「無音の故障」を検知する側が落ちて本末転倒になる)
  return executorName === 'fallback' && wantedEdit && !timedOut && !String(diffText || '').trim();
}

// 指示本文は execute() が stdin へ流す。argv には短いマーカーだけ渡す（長文を argv に載せると
// Windows の shell:true で壊れる。§1.17）
// shell:true の Windows では引数がエスケープされず連結されるので、
// どの引数にも空白を含めない（含めると qwen が位置引数と誤認して即死する。2026-09-03 実測）
export function buildQwenArgs({ model = 'deepseek-chat', timeoutSecs = 1800, maxToolCalls = 80, marker = 'Follow-the-instructions-provided-on-stdin.' } = {}) {
  return [
    '--auth-type', 'openai',
    '-m', model,
    '-y',
    '--exclude-tools', 'run_shell_command',
    '--max-wall-time', String(timeoutSecs),
    '--max-tool-calls', String(maxToolCalls),
    '-p', marker
  ];
}

export function buildGeminiArgs({ model = 'gemini-3.7-flash', marker = 'Follow-the-instructions-provided-on-stdin.' } = {}) {
  return ['-m', model, '--approval-mode', 'auto_edit', '--skip-trust', '-p', marker];
}

export function buildGeminiEnv(baseEnv, apiKey) {
  return {
    ...baseEnv,
    GEMINI_API_KEY: apiKey,
    GEMINI_CLI_TRUST_WORKSPACE: 'true'
  };
}

// フォールバックの1バックエンドに掛けていい上限秒数。
// 全体 --timeout より長くはできない。既定600秒、環境変数で上書き可。
export function fallbackBackendTimeoutSecs(timeoutSeconds, env = process.env) {
  const raw = Number(env.CODEX_DO_FALLBACK_BACKEND_TIMEOUT_SECS);
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : 600;
  return Math.max(60, Math.min(timeoutSeconds, wanted));
}

export function buildQwenEnv(baseEnv, apiKey, { model = 'deepseek-chat', baseUrl = 'https://api.deepseek.com/v1' } = {}) {
  const env = { ...baseEnv };
  env.OPENAI_API_KEY = apiKey;
  env.OPENAI_BASE_URL = baseUrl;
  env.OPENAI_MODEL = model;
  env.QWEN_CODE_SUPPRESS_YOLO_WARNING = '1';
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}

export function loadEnvKey(homeDir, fileName, varName) {
  if (process.env[varName]) return process.env[varName];
  const envFile = path.join(homeDir, '.claude', fileName);
  let content;
  try {
    content = fs.readFileSync(envFile, 'utf8');
  } catch {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(new RegExp(`^(?:export\\s+)?${varName}\\s*=\\s*(.*)$`));
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

export function loadDeepseekKey(homeDir) {
  return loadEnvKey(homeDir, 'deepseek.env', 'DEEPSEEK_API_KEY');
}

export function loadGeminiKey(homeDir) {
  const key = loadEnvKey(homeDir, 'gemini.env', 'GEMINI_API_KEY');
  if (key) return key;
  const envFile = path.join(homeDir, '.gemini', '.env');
  let content;
  try {
    content = fs.readFileSync(envFile, 'utf8');
  } catch {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
  return null;
}

// 2026-09-03 実測: Gemini Flash 5/5、DeepSeek 5/5、OpenRouter free 1/5。
// 同品質なら正規の auto_edit を持つ Gemini を安全性から第1候補にする。
// 費用ゼロを優先するときだけ CODEX_DO_PREFER_FREE=1 で free を先頭へ移す。
export function codexFallbackOrderFile(homeDir) {
  return path.join(homeDir, '.claude', 'codex-fallback-order.json');
}

// ~/.claude/codex-fallback-order.json で fallback 順を上書きできる
// (cost-improve-loop の codex_saturated 対処が書く。無ければ従来順)。
// 使える名前: "cheap-code:glm" / "cheap-code:deepseek" / "qwen" / "gemini-cli" / "openrouter-free"。
export function readCodexFallbackOrder(homeDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(codexFallbackOrderFile(homeDir), 'utf8'));
    if (!Array.isArray(parsed)) return null;
    const entries = parsed.map((x) => String(x).trim()).filter(Boolean);
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

function cheapCodeBackend(name, homeDir) {
  const provider = name.split(':')[1] || '';
  if (!['glm', 'deepseek'].includes(provider)) return null;
  // キーが無い機体で cheap-code を先頭にすると毎回即死するので、キーがある時だけ候補に入れる。
  const cooldownFile = path.join(homeDir, '.claude', 'provider-cooldown.json');
  // 仕様C2b: 定額レーン glm が usage_limit でクールダウン中のときは、同じ位置を deepseek へ自動差し替えする。
  if (provider === 'glm' && providerCooldownMs('glm', Date.now(), cooldownFile) > 0) {
    if (!loadEnvKey(homeDir, 'deepseek.env', 'DEEPSEEK_API_KEY')) return null;
    console.error('[codex-do] cheap-code:glm は usage_limit クールダウン中のため cheap-code:deepseek へフォールバックします');
    return { kind: 'cheap-code', name: 'cheap-code:deepseek', provider: 'deepseek', model: 'deepseek-v4-flash' };
  }
  const keyFile = provider === 'glm' ? 'zai.env' : 'deepseek.env';
  const keyEnv = provider === 'glm' ? 'ZAI_API_KEY' : 'DEEPSEEK_API_KEY';
  if (!loadEnvKey(homeDir, keyFile, keyEnv)) return null;
  return { kind: 'cheap-code', name, provider, model: provider === 'glm' ? 'glm-5.3' : 'deepseek-v4-flash' };
}

export function resolveFallbackBackends(homeDir) {
  const geminiKey = loadGeminiKey(homeDir);
  const openrouterKey = loadEnvKey(homeDir, 'openrouter.env', 'OPENROUTER_API_KEY');
  const deepseekKey = loadDeepseekKey(homeDir);
  const preferFree = process.env.CODEX_DO_PREFER_FREE === '1';
  const gemini = geminiKey && { kind: 'gemini', name: 'gemini-cli', model: process.env.CODEX_DO_GEMINI_MODEL || 'gemini-3.7-flash', apiKey: geminiKey };
  const deepseek = deepseekKey && { kind: 'qwen', name: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: deepseekKey };
  const openrouter = openrouterKey && { kind: 'qwen', name: 'openrouter-free', model: process.env.CODEX_DO_FREE_MODEL || 'cohere/north-mini-code:free', baseUrl: 'https://openrouter.ai/api/v1', apiKey: openrouterKey };
  const byName = {
    'gemini-cli': () => gemini,
    'qwen': () => deepseek,
    'openrouter-free': () => openrouter,
  };
  const order = readCodexFallbackOrder(homeDir);
  if (order) {
    const backends = [];
    for (const name of order) {
      const backend = name.startsWith('cheap-code:') ? cheapCodeBackend(name, homeDir) : byName[name]?.();
      if (backend) backends.push(backend);
      else console.error(`[codex-do] codex-fallback-order.json の ${name} はキー未設定か未知の名前のためスキップ`);
    }
    if (backends.length) return backends;
    console.error('[codex-do] codex-fallback-order.json に使えるバックエンドが無いため従来順へ戻します');
  }
  const ordered = preferFree ? [openrouter, gemini, deepseek] : [gemini, deepseek, openrouter];
  return ordered.filter(Boolean);
}

export function resolveQwenBackends(homeDir) {
  return resolveFallbackBackends(homeDir);
}

// 429/413 はコード上の行番号(例: "foo.ts:429:12")と衝突するため、コロンで数字に
// 隣接していない・かつ同じ行に HTTP/quota 文脈語があるときだけ一致とみなす。
function isHttpStatusCodeLine(line, code) {
  const index = line.search(new RegExp(`\\b${code}\\b`));
  if (index === -1) return false;
  if (/:\s*$/.test(line.slice(0, index))) return false;
  if (/^\s*:/.test(line.slice(index + code.length))) return false;
  return /too many requests|rate|limit|quota|payload|http|status|error/i.test(line);
}

// 無料枠の上限(429 / rate limit / quota / insufficient / Request too large / 413)に
// 当たった時に次のバックエンドへ落とすための判定。
export function isBackendExhausted(output, stderr) {
  const merged = `${output || ''}\n${stderr || ''}`;
  const lower = merged.toLowerCase();
  const patterns = ['rate limit', 'rate-limited', 'quota', 'insufficient', 'request too large'];
  if (patterns.some((p) => lower.includes(p))) return true;
  return merged.split(/\r?\n/).some((line) => isHttpStatusCodeLine(line, '429') || isHttpStatusCodeLine(line, '413'));
}

// WSL codex の起動確認は「codex が無い」と「一過性で起動できない」を分けて扱う。
// codex --version の失敗だけで「無い」と断定して npm i -g を走らせると、非root の
// WSL では EACCES で必ず失敗し、時間を消費した末にネイティブ(信頼できないディレクトリ
// では空出力で即終了)へ落ちる。codex-do の out=0 空出力行の根本原因(2026-09-08 実測)。
// 戻り値: 'wsl'=そのまま WSL codex で実行 / 'retry'=在るのに起動確認失敗→再試行(再インストールしない)
//         'install'=本当に無いときだけ1回インストール / 'native'=ネイティブへ(警告付き・trust チェック回避)。
export function wslCodexLaunchPlan({ distroFound, codexPresent, versionOk, installAttempted, retried }) {
  if (!distroFound) return 'native';
  if (versionOk) return 'wsl';
  if (codexPresent && !retried) return 'retry';
  if (!codexPresent && !installAttempted) return 'install';
  return 'native';
}

if (isEntry(import.meta.url)) {

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceNative = args.includes('--force-native');
const noFallback = args.includes('--no-fallback');
const review = args.includes('--review');
const noEscalate = args.includes('--no-escalate');
const modelIndex = args.indexOf('--model');
const effortIndex = args.indexOf('--effort');
const laneIndex = args.indexOf('--lane');
const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
const effort = effortIndex >= 0 ? args[effortIndex + 1] : undefined;
const lane = laneIndex >= 0 ? args[laneIndex + 1] : 'auto';
const cwdIndex = args.indexOf('--cwd');
const promptFileIndex = args.indexOf('--prompt-file');
const timeoutIndex = args.indexOf('--timeout');
const cwd = path.resolve(cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd());
// cwdIndex が -1 のとき cwdIndex+1 が 0 になり、指示文(第1引数)を捨ててしまうので条件付きで除外する。
const omitted = new Set();
if (dryRun) omitted.add(args.indexOf('--dry-run'));
if (forceNative) omitted.add(args.indexOf('--force-native'));
if (noFallback) omitted.add(args.indexOf('--no-fallback'));
if (review) omitted.add(args.indexOf('--review'));
if (noEscalate) omitted.add(args.indexOf('--no-escalate'));
for (const index of [modelIndex, effortIndex, laneIndex]) {
  if (index >= 0) { omitted.add(index); omitted.add(index + 1); }
}
if (cwdIndex >= 0) { omitted.add(cwdIndex); omitted.add(cwdIndex + 1); }
if (promptFileIndex >= 0) { omitted.add(promptFileIndex); omitted.add(promptFileIndex + 1); }
if (timeoutIndex >= 0) { omitted.add(timeoutIndex); omitted.add(timeoutIndex + 1); }
const usage = '使い方: node tools/codex-do.mjs "<指示>" [--cwd <path>] [--prompt-file <file>] [--review] [--timeout <秒>] [--model <slug|astra|sol>] [--effort <low|medium|high|xhigh|max>] [--lane <sol|astra|auto>] [--no-escalate] [--dry-run] [--no-fallback] [--force-native]';

if ((modelIndex >= 0 && (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(model))) ||
    (effortIndex >= 0 && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) ||
    !['sol', 'astra', 'auto'].includes(lane)) {
  console.error(`--model / --effort / --lane の指定が不正です\n${usage}`);
  process.exit(2);
}

// タイムアウト既定30分。無限に待って気付かないより、切って原因を見に行くほうが安い。
const timeoutSeconds = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : 1800;
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error(`--timeout は正の秒数で指定してください\n${usage}`);
  process.exit(2);
}

// 指示文はファイルから読むのを既定にする。argv で渡すとシェルがバッククォートを
// コマンド置換として実行し、仕様の一部が消えたプロンプトが Codex に届く(2026-08-26 実害)。
let instruction = args.filter((_, index) => !omitted.has(index)).join(' ').trim();
if (promptFileIndex >= 0) {
  const promptFile = args[promptFileIndex + 1];
  if (!promptFile) { console.error(`--prompt-file にファイルパスが必要です\n${usage}`); process.exit(2); }
  try {
    instruction = fs.readFileSync(promptFile, 'utf8');
  } catch (error) {
    console.error(`--prompt-file を読めません: ${promptFile} (${error.code || error.message})`);
    process.exit(2);
  }
}
if (!instruction.trim()) { console.error(usage); process.exit(2); }

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
let selectedLane = decideCodexLane({ lane, model, promptText: instruction, timeoutSecs: timeoutSeconds, review, astraCooldownMs: providerCooldownMs('codex-astra') });
if (effort) selectedLane.effort = effort;
if (selectedLane.reason.includes('astra_cooldown')) console.error('[codex-do] astra_cooldown: Astra クールダウン中のため Sol へ退避');
const logCodex = () => console.log(`[codex-do] executor=codex model=${selectedLane.slug} effort=${selectedLane.effort || 'default'} lane=${selectedLane.reason}`);
if (dryRun) { logCodex(); console.log(prompt); process.exit(0); }

// 実行前の作業ツリーを控える。未コミット差分が常時あるリポでは diff が空にならず、
// 下の「空diffなら書き込めていない」判定が一度も発火しないため（2026-09-03 実害）。
const treeSnapshot = () => `${spawnSync('git', ['-C', cwd, 'diff', '--stat'], { encoding: 'utf8' }).stdout || ''}\n${spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || ''}`;
const treeBefore = treeSnapshot();
const wantedEdit = !review && /実装|作って|修正|直して|追加して|リファクタ|refactor|fix|implement/i.test(instruction);
const started = Date.now();
let mockIndex = 0;
function execute(command, commandArgs, options = {}) {
  if (process.env.CODEX_DO_MOCK_RESULTS) {
    try {
      const mocks = JSON.parse(process.env.CODEX_DO_MOCK_RESULTS);
      const mock = mocks[mockIndex++];
      if (!mock) throw new Error('CODEX_DO_MOCK_RESULTS exhausted');
      if (mock) {
        if (mock.output) process.stdout.write(mock.output);
        if (mock.stderr) process.stderr.write(mock.stderr);
        return Promise.resolve({
          status: mock.status !== undefined ? mock.status : 0,
          output: mock.output || '',
          stderr: mock.stderr || '',
          outputChars: (mock.output || '').length,
          timedOut: mock.timedOut || false,
          error: mock.error || null
        });
      }
    } catch (e) {
      throw e;
    }
  }
  return new Promise((resolve) => {
    let outputChars = 0, output = '', stderr = '', timedOut = false;
    const callTimeoutSeconds = Number.isFinite(options.timeoutSecs) && options.timeoutSecs > 0
      ? options.timeoutSecs
      : timeoutSeconds;
    const spawnOptions = { ...options };
    delete spawnOptions.timeoutSecs;
    // stdio を全て pipe にして TTY を渡さない。TTY 付きで起動すると codex が端末入力を
    // 待ったまま眠り続ける(2026-08-26 に 1日00:57 hang した実害)。
    const child = spawn(command, commandArgs, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n⏱ ${command} が ${callTimeoutSeconds} 秒で応答を終えなかったので停止しました。--timeout で延長できます`);
      child.kill('SIGKILL');
    }, callTimeoutSeconds * 1000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { outputChars += chunk.length; output += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, error, outputChars, output, stderr }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status: timedOut ? 124 : status, outputChars, output, stderr, timedOut }); });
    // 指示は stdin で渡し、必ず閉じる。閉じないと codex が
    // "Reading additional input from stdin..." のまま永久に待つ。
    child.stdin.end(prompt);
  });
}
// cheap-code バックエンド: 指示は argv で渡さず一時ファイル経由(§1.17 argv経由の指示破壊防止)。
// shell も通さない(node の引数配列をそのまま渡す)。
async function executeCheapCode(backend, backendTimeout) {
  const promptFile = path.join(os.tmpdir(), `orgiast-codex-fallback-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(promptFile, prompt, 'utf8');
  try {
    const cheapCode = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cheap-code.mjs');
    return await execute(process.execPath, [cheapCode, '--provider', backend.provider, '--prompt-file', promptFile, '--cwd', cwd], { cwd, timeoutSecs: backendTimeout });
  } finally {
    try { fs.rmSync(promptFile, { force: true }); } catch {}
  }
}

let result;
let executorName = 'codex';
let fallbackBackend = null;
let lastBackend = null;

let escalated = false;
function recordUsage(result, modelName, seconds, provider = 'codex') {
  try {
    const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, `${JSON.stringify({
      t: new Date().toISOString(), provider, model: modelName,
      lane: selectedLane.reason, escalated,
      in: Math.ceil(prompt.length / 4), out: Math.ceil((result.outputChars || 0) / 4),
      timedOut: result?.timedOut === true,
      status: result?.status ?? null,
      secs: Number(seconds.toFixed(3))
    })}\n`, 'utf8');
  } catch {}
}
async function executeCodex() {
  const attemptStarted = Date.now();
  logCodex();
  const codexArgs = buildCodexExecArgs({ ...selectedLane, review });
  let result;

  if (process.platform === 'win32' && !forceNative) {
    const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le', timeout: 15000 });
    const distros = listed.status === 0 ? listed.stdout.split(/\r?\n/).map((x) => x.replace(/\0/g, '').trim()).filter(Boolean) : [];
    const distro = distros.find((x) => x.toLowerCase() === 'ubuntu') || distros[0];
    let usable = false;
    if (distro) {
      const versionProbe = () => {
        const probe = spawnSync('wsl', ['-d', distro, '--', 'codex', '--version'], { encoding: 'utf8', timeout: 15000 });
        return { ok: probe.status === 0, stderr: (probe.stderr || '').toString().trim().slice(0, 300) };
      };
      const present = spawnSync('wsl', ['-d', distro, '--', 'sh', '-lc', 'command -v codex >/dev/null 2>&1'], { timeout: 15000 }).status === 0;
      const first = versionProbe();
      usable = first.ok;
      const step = wslCodexLaunchPlan({ distroFound: true, codexPresent: present, versionOk: first.ok, installAttempted: false, retried: false });
      if (step === 'retry') {
        console.error(`WSL ${distro} には codex が在りますが起動確認が失敗しました。一過性の可能性があるため再試行します${first.stderr ? ` (${first.stderr})` : ''}`);
        usable = versionProbe().ok;
        if (!usable) console.error(`WSL ${distro} の codex は再試行でも起動確認できませんでした。在るのに失敗しているため npm 再インストールはしません`);
      } else if (step === 'install') {
        console.error(`WSL ${distro} に codex が見つからないため自動インストールを試します`);
        const installed = spawnSync('wsl', ['-d', distro, '--', 'npm', 'i', '-g', '@openai/codex'], { stdio: 'inherit', timeout: 120000 });
        if (installed.status === 0) usable = versionProbe().ok;
        else console.error(`WSL ${distro} への codex 自動インストールが失敗しました(exit ${installed.status})。WSL 内に手動で導入してください`);
      }
    }
    if (usable) {
      const gitFile = path.join(cwd, '.git');
      try {
        if (fs.statSync(gitFile).isFile() && needsWorktreeRepair(fs.readFileSync(gitFile, 'utf8'))) {
          const repaired = spawnSync('git', ['-C', cwd, '-c', 'worktree.useRelativePaths=true', 'worktree', 'repair'], { encoding: 'utf8' });
          if (repaired.status === 0) console.error('⚠️ Windows 絶対パスの gitdir は WSL 側 codex が解決できないため相対パスへ直しました');
          else console.error(`⚠️ Windows 絶対パスの gitdir を相対パスへ修復できませんでした（処理は続行します）: ${(repaired.stderr || repaired.error?.message || `exit ${repaired.status}`).trim()}`);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') console.error(`⚠️ worktree の gitdir 確認に失敗しました（処理は続行します）: ${error?.message ?? error}`);
      }
      result = await execute('wsl', ['-d', distro, '--cd', cwd, '--', 'codex', ...codexArgs]);
    }
    else {
      console.error('⚠️ WSL 経路が使えないためネイティブ Windows codex で実行します。\nWindows 版は read-only サンドボックス固定でファイルを書けない既知の不具合(openai/codex#35428)があり、編集が保存されない可能性が高い。WSL の導入を推奨');
      const nativeArgs = [...codexArgs];
      if (!fs.existsSync(path.join(cwd, '.git'))) nativeArgs.splice(-1, 0, '--skip-git-repo-check');
      result = await execute('codex', nativeArgs, { cwd });
    }
  } else {
    if (process.platform === 'win32') console.error('⚠️ --force-native によりネイティブ Windows codex で実行します。編集が保存されない可能性があります');
    const nativeArgs = [...codexArgs];
    if (!fs.existsSync(path.join(cwd, '.git'))) nativeArgs.splice(-1, 0, '--skip-git-repo-check');
    result = await execute('codex', nativeArgs, { cwd });
  }

  recordUsage(result, `codex-cli/${selectedLane.slug}`, (Date.now() - attemptStarted) / 1000);
  return result;
}

const failureReason = (result) => result.timedOut ? 'timedOut'
  : result.status !== 0 ? `exit_${result.status}`
  : wantedEdit && treeBefore.trim() === treeSnapshot().trim() ? 'empty_diff' : '';
let quotaCheck;
let quotaResetUntil = 0;
let escalationFailed = false;
let astraRetreated = false;
while (true) {
  result = await executeCodex();
  quotaCheck = detectQuotaLimit(result?.output, result?.stderr, result?.status, prompt);
  if (quotaCheck.matched && selectedLane.slug === ASTRA && !astraRetreated) {
    const resetUntil = parseCodexResetUntil(`${result.output || ''}\n${result.stderr || ''}`);
    try { writeCodexCooldown(resetUntil, 'codex-astra', 'usage_limit'); } catch {}
    try {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.appendFileSync(path.join(home, '.claude', 'codex-limit-history.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), model: ASTRA, pattern: quotaCheck.pattern })}\n`, 'utf8');
    } catch {}
    console.log('[codex-do] astra usage limit → sol へ退避');
    astraRetreated = true;
    selectedLane = { slug: SOL, effort, reason: 'astra_usage_limit' };
    continue;
  }
  const failure = failureReason(result);
  if (!quotaCheck.matched && failure && selectedLane.slug === SOL && lane === 'auto' && !model && !noEscalate && !escalated && !astraRetreated && providerCooldownMs('codex-astra') === 0) {
    console.log(`[codex-do] sol 失敗 → astra へ昇格 (理由: ${failure})`);
    escalated = true;
    selectedLane = { slug: ASTRA, effort: 'high', reason: `escalated:${failure}` };
    continue;
  }
  escalationFailed = escalated && Boolean(failure);
  if (escalationFailed && result.status === 0) result.status = 1;
  break;
}
const fallbackReason = quotaCheck.matched ? 'Codex usage limit を検出' : 'Astra 昇格後も失敗';
if (quotaCheck.matched || escalationFailed) {
  if (quotaCheck.matched) {
    quotaResetUntil = parseCodexResetUntil(`${result?.output || ''}\n${result?.stderr || ''}`);
    try { writeCodexCooldown(quotaResetUntil); } catch {}
  }
  if (noFallback) {
    if (quotaCheck.matched) console.error(`[codex-do] Codex usage limit detected: ${quotaCheck.pattern} at index ${quotaCheck.index}. Context: "${quotaCheck.snippet}"`);
    console.error(`[codex-do] --no-fallback is specified. Fallback skipped.`);
    if (result.status === 0 || result.status === null) {
      result.status = 1;
    }
  } else {
    executorName = 'fallback';
    console.log(`[codex-do] executor=fallback (理由: ${fallbackReason})`);
    if (quotaCheck.matched) console.error(`[codex-do] Codex usage limit detected: ${quotaCheck.pattern} at index ${quotaCheck.index}. Context: "${quotaCheck.snippet}"`);
    console.error(`[codex-do] Falling back to an agentic CLI...`);

    const backends = resolveFallbackBackends(home);
    if (backends.length === 0) {
      console.error('GEMINI_API_KEY、DEEPSEEK_API_KEY、OPENROUTER_API_KEY が無いためフォールバックを実行できません');
      result.status = 1;
    } else {
      const backendTimeout = fallbackBackendTimeoutSecs(timeoutSeconds);
      for (const backend of backends) {
        lastBackend = backend;
        console.log(`[codex-do] fallback backend=${backend.name} model=${backend.model}`);
        result = backend.kind === 'gemini'
          ? await execute('gemini', buildGeminiArgs({ model: backend.model }), {
              cwd,
              env: buildGeminiEnv(process.env, backend.apiKey),
              shell: process.platform === 'win32',
              timeoutSecs: backendTimeout
            })
          : backend.kind === 'cheap-code'
            ? await executeCheapCode(backend, backendTimeout)
            : await execute('qwen', buildQwenArgs({ timeoutSecs: backendTimeout, model: backend.model }), {
                cwd,
                env: buildQwenEnv(process.env, backend.apiKey, { model: backend.model, baseUrl: backend.baseUrl }),
                shell: process.platform === 'win32',
                timeoutSecs: backendTimeout
              });
        if (result.status === null) {
          console.error(`[codex-do] Failed to spawn ${backend.name} fallback:`, result.error);
          result.status = 1;
        }
        if (result.timedOut) {
          console.error(`[codex-do] backend=${backend.name} が ${backendTimeout} 秒でタイムアウトしたため次のバックエンドへ移ります`);
          continue;
        }
        if (result.status === 0) {
          fallbackBackend = backend;
          break;
        }
        if (isBackendExhausted(result.output, result.stderr)) {
          console.error(`[codex-do] backend=${backend.name} が上限/エラーで使えないため次へ`);
          continue;
        }
        // 上限/エラー以外の失敗(実装エラー等)は次のバックエンドへ落とさず、この結果で止める。
        break;
      }
    }
  }
}

const secs = (Date.now() - started) / 1000;
const reportedFallbackBackend = fallbackBackend ?? lastBackend;
const diff = spawnSync('git', ['-C', cwd, 'diff', '--stat'], { encoding: 'utf8' });
if (diff.stdout) process.stdout.write(diff.stdout);
// 読み取り専用の質問(説明して/調べて)では空diffが正常なので、指示自体が実装系のときだけ判定する。
// 「空か」ではなく「この実行で変わったか」を見る。
const treeUnchanged = treeBefore.trim() === treeSnapshot().trim();
if (executorName === 'codex') {
  if (wantedEdit && !result.timedOut && treeUnchanged && /実装|変更|修正|implemented|updated|modified/i.test(result.output || '')) {
    console.error('🚨 Codex は変更を書き込めていません（read-only サンドボックスの疑い）。WSL 経路で再実行してください');
    result.status = 1;
  }
}
// Gemini は引数を1つ取り違えるだけで使い方(ヘルプ)を出して exit 0 で終わる。
// DeepSeek / OpenRouter も含め、出力の中身を見ないと「1行も書かずに成功」を見逃す（2026-09-03 実測）。
if (shouldFlagEmptyFallbackDiff({ executorName, wantedEdit, timedOut: result.timedOut, diffText: diff.stdout })) {
  const printedUsage = /^\s*(Usage|使い方)[:：]|--approval-mode\s+Set the approval mode/m.test(result.output || result.stderr || '');
  const fallbackName = reportedFallbackBackend?.name ?? 'unknown';
  console.error(reportedFallbackBackend?.kind === 'gemini' && printedUsage
    ? '🚨 Gemini が使い方(ヘルプ)を表示して終了しました＝指示が届いていません。引数の渡し方を確認してください'
    : `🚨 フォールバック(${fallbackName})は作業ツリーを1行も変更していません。指示が届いたか確認してください`);
  result.status = 1;
}
if (quotaCheck.matched && executorName === 'fallback' && result?.status !== 0) {
  try { writeCodexCooldown(quotaResetUntil, undefined, 'usage_limit_no_fallback'); } catch {}
}
if (executorName === 'fallback') {
  recordUsage(result, `${reportedFallbackBackend?.name ?? 'unknown'}/${reportedFallbackBackend?.model ?? 'unknown'}`, secs, 'fallback');
}

console.log(`[codex-do] executor=${executorName}${executorName === 'fallback' ? `:${reportedFallbackBackend?.name ?? 'unknown'} (理由: ${fallbackReason})` : ''}`);
process.exit(result?.status ?? 1);
}
