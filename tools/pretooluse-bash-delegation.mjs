#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "pretooluse-bash-delegation", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "pretooluse-bash-delegation"}, {"kind": "keyserve-key", "ref": "deepseek.env#DEEPSEEK_API_KEY"}]};
import os from 'node:os';
import { classifyBashCommand } from './usage-stats.mjs';
import { implApproved, IMPLEMENTATION_DENIAL } from './lib/claude-approval.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

try {
  const raw = await readStdinWithTimeout();
  const j = JSON.parse(raw), tool = String(j.tool_name || ''); if (!/^(Bash|PowerShell)$/.test(tool)) process.exit(0);
  const command = String(j.tool_input?.command || '');
  if (classifyBashCommand(command) !== 'inline-program') process.exit(0);
  const size = command.length;
  if (size < 6000) process.exit(0);
  // 標準出力だけの集計・調査は委譲警告の対象外。書き込みを示す構文があれば対象に残す。
  if (!/>|\btee\b|\bSet-Content\b|\bOut-File\b|\bfs\s*\.\s*writeFile/i.test(command)) process.exit(0);
  const home = process.env.ORGIAST_HOME || os.homedir();
  const approval = implApproved(home, j.session_id);
  const result = approval
    ? { additionalContext: `user 承認 [CLAUDE-IMPL-OK] により許可（期限 ${approval.until}）` }
    : { permissionDecision: 'deny', permissionDecisionReason: `🔒 委譲ハードブロック(§1.18): Claude 単独実装は禁止。${IMPLEMENTATION_DENIAL}` };
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...result } }));
} catch {}
