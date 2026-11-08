#!/usr/bin/env node
// 無人セッション(auto-session / next-session-launch)の実行者選択と子プロセス組み立ての共有部品。
// どちらも「既定は cheap-code(定額/従量安)、失敗した時だけ claude -p --model sonnet へ落とす」で
// 挟む箇所がほぼ同じなのでここに切り出した(2026-09-07 B5)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

function claudeDirFor(home) { return path.join(home, '.claude'); }

export function parseAutoSessionEnvText(text) {
  const parsed = {};
  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (match) parsed[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return parsed;
}

export function autoSessionExecutor(env = process.env, hostname = os.hostname(), home = env.ORGIAST_HOME || os.homedir()) {
  // ~/.claude/auto-session.env をプロセスenvより優先する。ファイルは「この機体の固定指定」なので
  // 呼び出し元の一時envより強い(auto-session.mjs からの移設と同じ規則)。
  let fileEnv = {};
  try { fileEnv = parseAutoSessionEnvText(fs.readFileSync(path.join(home, '.claude', 'auto-session.env'), 'utf8')); } catch {}
  const merged = { ...env, ...fileEnv };
  return { executor: merged.ORGIAST_AUTO_SESSION_EXECUTOR || 'cheap-code', provider: merged.ORGIAST_AUTO_SESSION_PROVIDER || (/kim/i.test(hostname) ? 'glm' : 'deepseek') };
}

export function claudeFallbackEnabled(env = process.env, home = env.ORGIAST_HOME || os.homedir()) {
  let fileEnv = {};
  try { fileEnv = parseAutoSessionEnvText(fs.readFileSync(path.join(home, '.claude', 'auto-session.env'), 'utf8')); } catch {}
  return /^(?:1|true|on)$/i.test(String({ ...env, ...fileEnv }.ORGIAST_AUTO_SESSION_CLAUDE_FALLBACK || '').trim());
}

export function codexDoLaneEnabled(env = process.env, home = env.ORGIAST_HOME || os.homedir()) {
  let fileEnv = {};
  try { fileEnv = parseAutoSessionEnvText(fs.readFileSync(path.join(home, '.claude', 'auto-session.env'), 'utf8')); } catch {}
  return !/^(?:0|false|off)$/i.test(String({ ...env, ...fileEnv }.ORGIAST_AUTO_SESSION_CODEX_LANE ?? '').trim());
}

export function cheapProvidersAllCooling(provider, home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now()) {
  const alternate = provider === 'glm' ? 'deepseek' : provider === 'deepseek' ? 'glm' : null;
  if (!alternate) return false;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'provider-cooldown.json'), 'utf8'));
    return Number(state?.[provider === 'deepseek' ? 'openrouter' : provider]?.until) > now && Number(state?.[alternate === 'deepseek' ? 'openrouter' : alternate]?.until) > now;
  } catch { return false; }
}

export function alternateCheapProvider(provider, home = process.env.ORGIAST_HOME || os.homedir()) {
  const alternate = provider === 'glm' ? 'deepseek' : provider === 'deepseek' ? 'glm' : null;
  if (!alternate) return null;
  const keyFile = path.join(home, '.claude', alternate === 'glm' ? 'zai.env' : 'openrouter.env');
  const keyName = alternate === 'glm' ? 'ZAI_API_KEY' : 'OPENROUTER_API_KEY';
  try {
    if (!parseAutoSessionEnvText(fs.readFileSync(keyFile, 'utf8'))[keyName]) return null;
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'provider-cooldown.json'), 'utf8'));
    if (Number(state?.[alternate === 'deepseek' ? 'openrouter' : alternate]?.until) > Date.now()) return null;
  } catch (error) {
    if (error?.code !== 'ENOENT' && error instanceof SyntaxError) return null;
    try { if (!parseAutoSessionEnvText(fs.readFileSync(keyFile, 'utf8'))[keyName]) return null; } catch { return null; }
  }
  return alternate;
}

// 実行役(cheap-code.mjs)を「セッションが作業ブランチを切る tree」から読むと、夜間に origin/main へ
// 入った修正が同じ夜の後続セッションへ届かない。2026-10-25 実測: PR #1091(deepseek の
// API_TIMEOUT_MS=240s)が 02:07 JST に main へ入った後も auto-session-repo は未マージ枝のままで、
// 後続セッションは修正前の cheap-code で走っていた(= 修正済み通知の再起票)。
// 専用の detached worktree を origin/main に同期し、セッション開始ごとに更新する。
export const EXECUTOR_SYNC_TTL_MS = 5 * 60 * 1000;

export function executorWorktreePath(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', 'auto-session-executor');
}

export function planExecutorWorktreeSync({ repoRoot, executorRoot, hasTree }) {
  return hasTree
    ? [
        // worktree は同じ repo の ref を共有するので、fetch は repoRoot 側で1回でよい。
        { label: 'fetch executor origin/main', cwd: repoRoot, args: ['fetch', 'origin', 'main', '--quiet'] },
        { label: 'reset executor', cwd: executorRoot, args: ['reset', '--hard', 'origin/main', '--quiet'] },
        { label: 'clean executor', cwd: executorRoot, args: ['clean', '-fd', '--quiet'] },
      ]
    : [{ label: 'create executor worktree', cwd: repoRoot, args: ['worktree', 'add', '--detach', executorRoot, 'origin/main'] }];
}

const defaultExecutorState = { root: '', at: 0 };

// 返り値は「実際に cheap-code.mjs を読み込む tree」。同期に失敗した時は呼び出し元の tree に戻す
// (無人実行を止めない)。state はテスト用に差し替え可能。
export function prepareExecutorRoot(options = {}) {
  const {
    repoRoot,
    home = process.env.ORGIAST_HOME || os.homedir(),
    env = process.env,
    now = Date.now(),
    ttlMs = EXECUTOR_SYNC_TTL_MS,
    run = (command, args, runOptions) => spawnSync(command, args, {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
      // 認証待ちで無人セッションを止めない。fetch は既存の資格情報だけで行う。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      ...runOptions,
    }),
    exists = fs.existsSync,
    log = () => {},
    state = defaultExecutorState,
  } = options;
  if (env.ORGIAST_EXECUTOR_ROOT) return env.ORGIAST_EXECUTOR_ROOT;
  if (state.root && now - state.at < ttlMs) return state.root;
  const executorRoot = executorWorktreePath(home);
  try {
    const commands = planExecutorWorktreeSync({
      repoRoot,
      executorRoot,
      hasTree: exists(path.join(executorRoot, 'tools', 'cheap-code.mjs')),
    });
    for (const command of commands) {
      const result = run('git', command.args, { cwd: command.cwd });
      if (result?.error || result?.status !== 0) {
        const detail = String(result?.stderr || result?.error?.message || `exit ${result?.status}`).trim();
        throw new Error(`${command.label} が失敗: ${detail}`);
      }
    }
    if (!exists(path.join(executorRoot, 'tools', 'cheap-code.mjs'))) throw new Error('cheap-code.mjs が見つかりません');
    state.root = executorRoot;
    state.at = now;
    return executorRoot;
  } catch (error) {
    log(`[executor] origin/main の実行役を用意できないため ${repoRoot} のコードで続行します: ${error?.message ?? error}`);
    return repoRoot;
  }
}

// cheap-code 子プロセスの引数。指示は argv でなく prompt-file 経由(§1.17 argv経由の指示破壊防止)。
export function buildCheapCodeArgs({ repoRoot, provider, promptFile, cwd }) {
  const cheapCode = path.join(repoRoot, 'tools', 'cheap-code.mjs');
  if (!fs.existsSync(cheapCode)) throw new Error(`cheap-code.mjs が見つかりません: ${cheapCode}`);
  return [cheapCode, '--provider', provider, '--prompt-file', promptFile, '--cwd', cwd];
}

export function buildCodexDoArgs({ repoRoot, promptFile, cwd }) {
  const codexDo = path.join(repoRoot, 'tools', 'codex-do.mjs');
  if (!fs.existsSync(codexDo)) throw new Error(`codex-do.mjs が見つかりません: ${codexDo}`);
  return [codexDo, '--prompt-file', promptFile, '--cwd', cwd, '--origin', 'unattended'];
}

// cheap-code が失敗した時の最終手段: claude -p(headless) 。無人の残TODO消化に Opus は過剰なので Sonnet。
export function buildClaudeHeadlessArgs({ repoCwd, historyCwd, model = process.env.ORGIAST_AUTO_SESSION_MODEL || 'sonnet', resumeSessionId }) {
  // --permission-mode auto を明示的に渡す。以前は「渡さず ~/.claude/settings.json の既定 auto を
  // 継承する」設計だったが、2026-09-17 に実機の settings.json を直接確認したところ
  // permissions.defaultMode が未設定（allow は4件のみ）だった。継承先が存在しない前提だったため、
  // 無人の headless 実行は git/gh/Write などで承認待ちのまま進めなくなっていた
  // （acceptEdits はファイル編集だけ自動承認し Bash が最初のコマンドで止まるため使えない。2026-08-26 実測）。
  // auto は「危険操作は依然ブロックする」既定の安全モードなので --dangerously-skip-permissions とは別物。
  const args = ['-p', '', '--permission-mode', 'auto', '--output-format', 'json', '--model', model, '--add-dir', repoCwd];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  if (historyCwd !== repoCwd) args.push('--add-dir', historyCwd);
  return args;
}

// ~/.claude/auto-session.env へ executor/provider を固定する(cost-improve-loop の writeAutoSessionExecutorEnv と同値の書き方)。
export function writeAutoSessionEnv({ home = process.env.ORGIAST_HOME || os.homedir(), executor = 'cheap-code', provider, writeImpl = null } = {}) {
  if (!['cheap-code', 'claude', 'codex'].includes(String(executor))) throw new Error(`不正な executor です: ${executor}`);
  if (!/^[a-z0-9_-]+$/.test(String(provider || ''))) throw new Error(`不正な provider です: ${provider}`);
  const file = path.join(claudeDirFor(home), 'auto-session.env');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch {}
  const parsed = parseAutoSessionEnvText(text);
  const wanted = { ORGIAST_AUTO_SESSION_EXECUTOR: String(executor), ORGIAST_AUTO_SESSION_PROVIDER: String(provider) };
  const changed = Object.entries(wanted).some(([key, value]) => parsed[key] !== value);
  if (changed) {
    const merged = { ...parsed, ...wanted };
    const content = `${Object.entries(merged).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
    if (writeImpl) writeImpl(file, content);
    else { fs.mkdirSync(claudeDirFor(home), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); }
  }
  return { file, ...wanted, changed };
}

// cheap-code → claude への落下を台帳(executor-usage.jsonl)に残す。失敗しても例外を投げない。
export function recordFallbackToClaude({ home = process.env.ORGIAST_HOME || os.homedir(), reason, model = process.env.ORGIAST_AUTO_SESSION_MODEL || 'sonnet', appendImpl = null, now = new Date() } = {}) {
  try {
    const row = `${JSON.stringify({ t: now.toISOString(), provider: 'claude-fallback', model, status: 'fallback', reason: String(reason || 'unknown') })}\n`;
    if (appendImpl) appendImpl(path.join(home, '.claude', 'executor-usage.jsonl'), row, 'utf8');
    else {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.appendFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), row, 'utf8');
    }
  } catch {}
}

export function recordSkippedNoExecutor({ home = process.env.ORGIAST_HOME || os.homedir(), reason, provider, stderr = '', appendImpl = null, now = new Date() } = {}) {
  try {
    // 原因（上限・残高・無人枠）が台帳に残らないと delegation-health が外部要因の停止を全滅と誤診する。末尾200字だけ残す。
    const tail = String(stderr || '').trim().slice(-200);
    const row = `${JSON.stringify({ t: now.toISOString(), provider: 'skipped', category: 'unrouted', model: 'none', status: 'no-cheap-executor', reason: String(reason || provider || 'unknown'), ...(tail ? { stderrTail: tail } : {}) })}\n`;
    const file = path.join(home, '.claude', 'executor-usage.jsonl');
    if (appendImpl) appendImpl(file, row, 'utf8');
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, row, 'utf8'); }
  } catch {}
}

function main(argv) {
  const setIndex = argv.indexOf('--set');
  if (setIndex < 0) {
    console.error('使い方: node tools/auto-session-executor.mjs --set cheap-code --provider glm|deepseek  (~/.claude/auto-session.env を更新)');
    return 2;
  }
  const executor = argv[setIndex + 1];
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex >= 0 ? argv[providerIndex + 1] : '';
  if (!executor || !provider) { console.error('--set と --provider が必要です'); return 2; }
  try {
    const result = writeAutoSessionEnv({ executor, provider });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
