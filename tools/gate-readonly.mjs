#!/usr/bin/env node
// GATE_CONTRACT is literal JSON for gate-contracts.mjs to discover this gate
export const GATE_CONTRACT = {"name": "gate-readonly", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "gate-readonly"}]};
import { isReadonlyCommand } from './readonly-command.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

try {
  const raw = await readStdinWithTimeout();
  const j = JSON.parse(raw);
  const tool = String(j.tool_name || '');
  // Only Bash/PowerShell commands are candidates for readonly delegation
  if (!/^(Bash|PowerShell)$/.test(tool)) process.exit(0);
  const command = String(j.tool_input?.command || '');
  // Non-readonly commands pass through to normal permission handling
  if (!isReadonlyCommand(command)) process.exit(0);
  // Allow readonly commands without prompting for permission
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: '読み取り専用コマンドのため自動許可',
    },
  }));
} catch {
  // fail-open: if the hook input is unparseable, let other gates decide
}