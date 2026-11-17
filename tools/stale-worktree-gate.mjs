#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "stale-worktree-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "stale-worktree-gate"}]};
// PreToolUse gate: 実行元ツリー固着型を検出する。
// Bash/PowerShell の cwd が nightly-repo 以外の古い worktree/別クローンで、
// かつ定期ジョブ系のコマンドを実行しようとしている場合に block する。
// docs/x-0045-missing-gates.md 優先2「実行元ツリー固着型」

import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const STALE_PATHS = [
  /auto-session-repo/i,
  /wt-/i,
  /orgiast-main/i,
  /Downloads[\\/]orgiast-claude-rules/i,
];

// 読み取り専用コマンド（副作用無し）は除外
const READ_ONLY_COMMAND = /^(?:cd\s|git\s+(?:status|log|diff|show|rev-parse|fetch\s+--dry-run|worktree)\b|node\s+(?:-e|--eval|-p|--print)\b)/i;

// 管理用操作
const MANAGEMENT_COMMAND = /git\s+worktree\s+(?:add|remove|list|prune)|node\s+.*(?:setup|converge|manifest)\.mjs/i;

// dry-run
const DRY_RUN = /--dry[-_]?run\b/i;

export function evaluateStaleWorktree(command, cwd) {
  if (!command || typeof command !== 'string') return { decision: 'pass' };

  // 読み取り専用・管理操作・dry-run は除外
  if (READ_ONLY_COMMAND.test(command)) return { decision: 'pass' };
  if (MANAGEMENT_COMMAND.test(command)) return { decision: 'pass' };
  if (DRY_RUN.test(command)) return { decision: 'pass' };

  // cwd が指定されていない場合も pass
  if (!cwd || typeof cwd !== 'string') return { decision: 'pass' };

  // stale path に該当するか
  const isStale = STALE_PATHS.some(p => p.test(cwd));
  if (!isStale) return { decision: 'pass' };

  // .claude/ 配下の設定ファイル操作は除外（ただし auto-session-repo 自体は対象）
  if (/\.claude[/\\](?:settings|memory|skills|hooks|agents)/.test(cwd)) return { decision: 'pass' };

  return {
    decision: 'block',
    reason: `[STALE-WORKTREE] 実行元のパス "${cwd}" は nightly-repo 以外の作業ツリーです。古いツリーでジョブを実行すると、移行済みの経路が旧コードで叩かれてサイレント障害が発生する可能性があります。nightly-repo で実行するか、このパスでの実行が意図的であれば「続行」を選択してください。`,
    code: 'STALE-WORKTREE',
  };
}

if (isEntry(import.meta.url)) {
  const stdin = await readStdinWithTimeout();
  if (stdin.trim()) {
    try {
      const data = JSON.parse(stdin);
      const toolInput = data.tool_input || data.input || {};
      const command = toolInput.command || data.command || '';
      const cwd = toolInput.cwd || data.cwd || data.cwd || process.cwd();
      const result = evaluateStaleWorktree(command, cwd);
      if (result.decision === 'block') {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: result.reason,
          },
        }) + '\n');
      }
    } catch (error) {
      console.error(`[STALE-WORKTREE-GATE] ${error.message}`);
    }
  }
}