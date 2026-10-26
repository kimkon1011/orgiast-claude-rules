#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"exec-tree-edit-guard","remedies":[{"kind":"command","ref":"node tools/onboarding-sync.mjs --force"}]};
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const REASON = [
  '実行ツリー ~/orgiast-claude-rules は正本の古いコピーで、直接の編集は onboarding-sync で消えます。',
  '編集は ~/.claude/nightly-repo で git fetch origin を行い、origin/main の該当ファイルと gh pr list --repo kimkon1011/orgiast-claude-rules --state all --search <語> で既修正を確認してから worktree で行ってください。',
  '既に直っていれば node ~/orgiast-claude-rules/tools/onboarding-sync.mjs --force で反映してください。',
].join('\n');

function normalizedPath(value) {
  return path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/$/, '').toLowerCase();
}

export function evaluateExecTreeEditGuard(input, { home = os.homedir(), env = process.env } = {}) {
  if (env.ORGIAST_ALLOW_EXEC_TREE_EDIT === '1') return null;
  if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(input?.tool_name || '')) return null;
  const file = input.tool_input?.[input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path'];
  if (typeof file !== 'string' || !file) return null;
  const root = normalizedPath(`${home}/orgiast-claude-rules`);
  const target = normalizedPath(file);
  if (target !== root && !target.startsWith(`${root}/`)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON } };
}

async function main() {
  try {
    const output = evaluateExecTreeEditGuard(JSON.parse(await readStdinWithTimeout()));
    if (output) console.log(JSON.stringify(output));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
