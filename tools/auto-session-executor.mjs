#!/usr/bin/env node
// 無人セッション(auto-session / next-session-launch)の実行者選択と子プロセス組み立ての共有部品。
// どちらも「既定は cheap-code(定額/従量安)、失敗した時だけ claude -p --model sonnet へ落とす」で
// 挟む箇所がほぼ同じなのでここに切り出した(2026-09-07 B5)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
