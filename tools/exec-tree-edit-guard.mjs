#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"exec-tree-edit-guard","remedies":[{"kind":"command","ref":"node tools/onboarding-sync.mjs --force"}]};
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const REASON = [
  '実行ツリー ~/orgiast-claude-rules は正本の古いコピーで、直接の編集は onboarding-sync で消えます。',
  '編集は ~/.claude/nightly-repo で git fetch origin を行い、origin/main の該当ファイルと gh pr list --repo kimkon1011/orgiast-claude-rules --state all --search <語> で既修正を確認してから worktree で行ってください。',
  '既に直っていれば node ~/orgiast-claude-rules/tools/onboarding-sync.mjs --force で反映してください。',
].join('\n');

const NIGHTLY_REASON = [
  '~/.claude/nightly-repo は nightly-bootstrap が 2 分ごとに origin/main へ reset する実行ツリーで、未コミットの編集は rescue/auto-session-* ブランチへ自動退避されます。',
  '編集は git -C ~/.claude/nightly-repo worktree add <別ディレクトリ> -b <branch> origin/main で作った worktree か、別クローン（例: ~/.claude/<目的>-repo）で行ってください。',
  'PR は gh pr create --label automerge で作成してください。',
].join('\n');

function normalizedPath(value) {
  return path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/$/, '').toLowerCase();
}

export function evaluateExecTreeEditGuard(input, { home = os.homedir(), env = process.env, fs: fileSystem = fs } = {}) {
  if (env.ORGIAST_ALLOW_EXEC_TREE_EDIT === '1') return null;
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(input?.tool_name || '')) return null;
  const file = input.tool_input?.[input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path'];
  if (typeof file !== 'string' || !file) return null;
  const root = normalizedPath(`${home}/orgiast-claude-rules`);
  const target = normalizedPath(file);
  let reason = REASON;
  if (target !== root && !target.startsWith(`${root}/`)) {
    const nightly = normalizedPath(`${home}/.claude/nightly-repo`);
    if (target !== nightly && !target.startsWith(`${nightly}/`)) return null;
    const first = target.slice(nightly.length + 1).split('/')[0];
    if (['scratch', '.work', '.fleet-mail-work', '.wt'].includes(first) || first.startsWith('.work-')) return null;
    // Keep the original casing for filesystem checks on case-sensitive hosts.
    const original = path.posix.normalize(file.replace(/\\/g, '/'));
    const firstOriginal = original.slice(nightly.length + 1).split('/')[0];
    if (first && fileSystem.existsSync(`${original.slice(0, nightly.length)}/${firstOriginal}/.git`)) return null;
    reason = NIGHTLY_REASON;
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

async function main() {
  try {
    const output = evaluateExecTreeEditGuard(JSON.parse(await readStdinWithTimeout()));
    if (output) console.log(JSON.stringify(output));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
