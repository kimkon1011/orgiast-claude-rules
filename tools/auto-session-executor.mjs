#!/usr/bin/env node
// 無人セッション(auto-session / next-session-launch)の実行者選択と子プロセス組み立ての共有部品。
// どちらも「既定は cheap-code(定額/従量安)、失敗した時だけ claude -p --model sonnet へ落とす」で
// 挟む箇所がほぼ同じなのでここに切り出した(2026-09-07 B5)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export function alternateCheapProvider(provider, home = process.env.ORGIAST_HOME || os.homedir()) {
  const alternate = provider === 'glm' ? 'deepseek' : provider === 'deepseek' ? 'glm' : null;
  if (!alternate) return null;
  const keyFile = path.join(home, '.claude', alternate === 'glm' ? 'zai.env' : 'deepseek.env');
  const keyName = alternate === 'glm' ? 'ZAI_API_KEY' : 'DEEPSEEK_API_KEY';
  try {
    if (!parseAutoSessionEnvText(fs.readFileSync(keyFile, 'utf8'))[keyName]) return null;
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'provider-cooldown.json'), 'utf8'));
    if (Number(state?.[alternate]?.until) > Date.now()) return null;
  } catch (error) {
    if (error?.code !== 'ENOENT' && error instanceof SyntaxError) return null;
    try { if (!parseAutoSessionEnvText(fs.readFileSync(keyFile, 'utf8'))[keyName]) return null; } catch { return null; }
  }
  return alternate;
}

// cheap-code 子プロセスの引数。指示は argv でなく prompt-file 経由(§1.17 argv経由の指示破壊防止)。
export function buildCheapCodeArgs({ repoRoot, provider, promptFile, cwd }) {
  return [path.join(repoRoot, 'tools', 'cheap-code.mjs'), '--provider', provider, '--prompt-file', promptFile, '--cwd', cwd];
}

// cheap-code が失敗した時の最終手段: claude -p(headless) 。無人の残TODO消化に Opus は過剰なので Sonnet。
export function buildClaudeHeadlessArgs({ repoCwd, historyCwd, model = process.env.ORGIAST_AUTO_SESSION_MODEL || 'sonnet' }) {
  // --permission-mode を渡さず ~/.claude/settings.json の既定 auto を継承すると Bash も通る
  // (acceptEdits はファイル編集だけ自動承認し Bash が最初のコマンドで止まる。2026-08-26 実測)。
  const args = ['-p', '', '--output-format', 'json', '--model', model, '--add-dir', repoCwd];
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

export function recordSkippedNoExecutor({ home = process.env.ORGIAST_HOME || os.homedir(), reason, provider, appendImpl = null, now = new Date() } = {}) {
  try {
    const row = `${JSON.stringify({ t: now.toISOString(), provider: 'skipped', model: 'none', status: 'no-cheap-executor', reason: String(reason || provider || 'unknown') })}\n`;
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
