#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { parseCodexResetUntil, writeCodexCooldown } from './codex-cooldown.mjs';

// Windows の shell 経由起動では引数がクォートされないため、この値に空白を入れると
// -p の値が割れて Gemini が使い方(ヘルプ)を出して終わる。空白を入れないこと。
export const GEMINI_PROMPT_FLAG = 'Execute_the_implementation_instructions_provided_on_stdin.';

export function needsWorktreeRepair(gitFileContent) {
  return /^gitdir:\s*[A-Za-z]:/i.test(String(gitFileContent ?? '').trim());
}

export function detectQuotaLimit(stdout, stderr) {
  const merged = `${stdout || ''}\n${stderr || ''}`;
  const patterns = [
    { name: "You've hit your usage limit", regex: /You've hit your usage limit/i },
    { name: "usage limit", regex: /usage limit/i },
    { name: "rate limit", regex: /rate limit/i },
    { name: "429", regex: /429/i },
    { name: "Upgrade to Pro", regex: /Upgrade to Pro/i }
  ];
  for (const { name, regex } of patterns) {
    const match = merged.match(regex);
    if (match) {
      const index = match.index;
      const start = Math.max(0, index - 40);
      const end = Math.min(merged.length, index + match[0].length + 40);
      const snippet = merged.slice(start, end).replace(/\r?\n/g, ' ');
      return { matched: true, pattern: name, index, snippet };
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
export function resolveFallbackBackends(homeDir) {
  const backends = [];
  const geminiKey = loadGeminiKey(homeDir);
  const openrouterKey = loadEnvKey(homeDir, 'openrouter.env', 'OPENROUTER_API_KEY');
  const deepseekKey = loadDeepseekKey(homeDir);
  const preferFree = process.env.CODEX_DO_PREFER_FREE === '1';
  const gemini = geminiKey && { kind: 'gemini', name: 'gemini-cli', model: process.env.CODEX_DO_GEMINI_MODEL || 'gemini-3.7-flash', apiKey: geminiKey };
  const deepseek = deepseekKey && { kind: 'qwen', name: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: deepseekKey };
  const openrouter = openrouterKey && { kind: 'qwen', name: 'openrouter-free', model: process.env.CODEX_DO_FREE_MODEL || 'cohere/north-mini-code:free', baseUrl: 'https://openrouter.ai/api/v1', apiKey: openrouterKey };
  const ordered = preferFree ? [openrouter, gemini, deepseek] : [gemini, deepseek, openrouter];
  backends.push(...ordered.filter(Boolean));
  return backends;
}

export function resolveQwenBackends(homeDir) {
  return resolveFallbackBackends(homeDir);
}

// 無料枠の上限(429 / rate limit / quota / insufficient / Request too large / 413)に
// 当たった時に次のバックエンドへ落とすための判定。
export function isBackendExhausted(output, stderr) {
  const merged = `${output || ''}\n${stderr || ''}`.toLowerCase();
  const patterns = ['429', 'rate limit', 'rate-limited', 'quota', 'insufficient', 'request too large', '413'];
  return patterns.some((p) => merged.includes(p));
}

if (isEntry(import.meta.url)) {

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const forceNative = args.includes('--force-native');
const noFallback = args.includes('--no-fallback');
const cwdIndex = args.indexOf('--cwd');
const promptFileIndex = args.indexOf('--prompt-file');
const timeoutIndex = args.indexOf('--timeout');
const cwd = path.resolve(cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd());
// cwdIndex が -1 のとき cwdIndex+1 が 0 になり、指示文(第1引数)を捨ててしまうので条件付きで除外する。
const omitted = new Set();
if (dryRun) omitted.add(args.indexOf('--dry-run'));
if (forceNative) omitted.add(args.indexOf('--force-native'));
if (noFallback) omitted.add(args.indexOf('--no-fallback'));
if (cwdIndex >= 0) { omitted.add(cwdIndex); omitted.add(cwdIndex + 1); }
if (promptFileIndex >= 0) { omitted.add(promptFileIndex); omitted.add(promptFileIndex + 1); }
if (timeoutIndex >= 0) { omitted.add(timeoutIndex); omitted.add(timeoutIndex + 1); }
const usage = '使い方: node tools/codex-do.mjs "<指示>" [--cwd <path>] [--prompt-file <file>] [--timeout <秒>] [--dry-run] [--no-fallback]';

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
    instruction = fs.readFileSync(promptFile, 'utf8').trim();
  } catch (error) {
    console.error(`--prompt-file を読めません: ${promptFile} (${error.code || error.message})`);
    process.exit(2);
  }
}
if (!instruction) { console.error(usage); process.exit(2); }

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

// 実行前の作業ツリーを控える。未コミット差分が常時あるリポでは diff が空にならず、
// 下の「空diffなら書き込めていない」判定が一度も発火しないため（2026-09-03 実害）。
const treeSnapshot = () => `${spawnSync('git', ['-C', cwd, 'diff', '--stat'], { encoding: 'utf8' }).stdout || ''}\n${spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8' }).stdout || ''}`;
const treeBefore = treeSnapshot();
const started = Date.now();
let mockIndex = 0;
function execute(command, commandArgs, options = {}) {
  if (process.env.CODEX_DO_MOCK_RESULTS) {
    try {
      const mocks = JSON.parse(process.env.CODEX_DO_MOCK_RESULTS);
      const mock = mocks[mockIndex++];
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
      console.error('[MOCK ERROR]', e);
    }
  }
  return new Promise((resolve) => {
    let outputChars = 0, output = '', stderr = '', timedOut = false;
    // stdio を全て pipe にして TTY を渡さない。TTY 付きで起動すると codex が端末入力を
    // 待ったまま眠り続ける(2026-08-26 に 1日00:57 hang した実害)。
    const child = spawn(command, commandArgs, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n⏱ ${command} が ${timeoutSeconds} 秒で応答を終えなかったので停止しました。--timeout で延長できます`);
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
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
let result;
let executorName = 'codex';
let fallbackBackend = null;
let lastBackend = null;

// 先頭に1行で出力する
console.log('[codex-do] executor=codex');

if (process.platform === 'win32' && !forceNative) {
  const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le', timeout: 15000 });
  const distros = listed.status === 0 ? listed.stdout.split(/\r?\n/).map((x) => x.replace(/\0/g, '').trim()).filter(Boolean) : [];
  const distro = distros.find((x) => x.toLowerCase() === 'ubuntu') || distros[0];
  let usable = false;
  if (distro) {
    usable = spawnSync('wsl', ['-d', distro, '--', 'codex', '--version'], { stdio: 'ignore', timeout: 15000 }).status === 0;
    if (!usable) {
      console.error(`WSL ${distro} に Codex がないため自動インストールを試します`);
      spawnSync('wsl', ['-d', distro, '--', 'npm', 'i', '-g', '@openai/codex'], { stdio: 'inherit', timeout: 120000 });
      usable = spawnSync('wsl', ['-d', distro, '--', 'codex', '--version'], { stdio: 'ignore', timeout: 15000 }).status === 0;
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
    result = await execute('wsl', ['-d', distro, '--cd', cwd, '--', 'codex', 'exec', '-s', 'workspace-write', '-']);
  }
  else {
    console.error('⚠️ WSL 経路が使えないためネイティブ Windows codex で実行します。\nWindows 版は read-only サンドボックス固定でファイルを書けない既知の不具合(openai/codex#35428)があり、編集が保存されない可能性が高い。WSL の導入を推奨');
    result = await execute('codex', ['exec', '-s', 'workspace-write', '-'], { cwd });
  }
} else {
  if (process.platform === 'win32') console.error('⚠️ --force-native によりネイティブ Windows codex で実行します。編集が保存されない可能性があります');
  result = await execute('codex', ['exec', '-s', 'workspace-write', '-'], { cwd });
}

const quotaCheck = detectQuotaLimit(result?.output, result?.stderr);
let quotaResetUntil = 0;
if (quotaCheck.matched) {
  quotaResetUntil = parseCodexResetUntil(`${result?.output || ''}\n${result?.stderr || ''}`);
  try {
    writeCodexCooldown(quotaResetUntil);
  } catch {}
  if (noFallback) {
    console.error(`[codex-do] Codex usage limit detected: ${quotaCheck.pattern} at index ${quotaCheck.index}. Context: "${quotaCheck.snippet}"`);
    console.error(`[codex-do] --no-fallback is specified. Fallback skipped.`);
    if (result.status === 0 || result.status === null) {
      result.status = 1;
    }
  } else {
    executorName = 'fallback';
    console.log(`[codex-do] executor=fallback (理由: Codex usage limit を検出)`);
    console.error(`[codex-do] Codex usage limit detected: ${quotaCheck.pattern} at index ${quotaCheck.index}. Context: "${quotaCheck.snippet}"`);
    console.error(`[codex-do] Falling back to an agentic CLI...`);

    const backends = resolveFallbackBackends(home);
    if (backends.length === 0) {
      console.error('GEMINI_API_KEY、DEEPSEEK_API_KEY、OPENROUTER_API_KEY が無いためフォールバックを実行できません');
      result.status = 1;
    } else {
      for (const backend of backends) {
        lastBackend = backend;
        console.log(`[codex-do] fallback backend=${backend.name} model=${backend.model}`);
        result = backend.kind === 'gemini'
          ? await execute('gemini', buildGeminiArgs({ model: backend.model }), {
              cwd,
              env: buildGeminiEnv(process.env, backend.apiKey),
              shell: process.platform === 'win32'
            })
          : await execute('qwen', buildQwenArgs({ timeoutSecs: timeoutSeconds, model: backend.model }), {
              cwd,
              env: buildQwenEnv(process.env, backend.apiKey, { model: backend.model, baseUrl: backend.baseUrl }),
              shell: process.platform === 'win32'
            });
        if (result.status === null) {
          console.error(`[codex-do] Failed to spawn ${backend.name} fallback:`, result.error);
          result.status = 1;
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
const wantedEdit = /実装|作って|修正|直して|追加して|リファクタ|refactor|fix|implement/i.test(instruction);
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
if (executorName === 'fallback' && result?.status !== 0) {
  try { writeCodexCooldown(quotaResetUntil, undefined, 'usage_limit_no_fallback'); } catch {}
}
try {
  const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const usage = {
    t: new Date().toISOString(),
    provider: executorName,
    model: executorName === 'fallback' ? `${reportedFallbackBackend?.name ?? 'unknown'}/${reportedFallbackBackend?.model ?? 'unknown'}` : 'codex-cli',
    in: Math.ceil(prompt.length / 4),
    out: Math.ceil((result.outputChars || 0) / 4),
    secs: Number(secs.toFixed(3))
  };
  fs.appendFileSync(ledger, `${JSON.stringify(usage)}\n`, 'utf8');
} catch {}

console.log(`[codex-do] executor=${executorName}${executorName === 'fallback' ? `:${reportedFallbackBackend?.name ?? 'unknown'} (理由: Codex usage limit を検出)` : ''}`);
process.exit(result?.status ?? 1);
}
