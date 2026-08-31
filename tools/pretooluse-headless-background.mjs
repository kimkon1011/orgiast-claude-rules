#!/usr/bin/env node

try {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  if (process.env.CLAUDE_HEADLESS !== '1') process.exit(0);
  const input = JSON.parse(raw);
  const tool = String(input.tool_name || '');
  let reason = '';
  if (tool === 'ScheduleWakeup') {
    reason = 'ヘッドレス自動セッション（CLAUDE_HEADLESS=1）では ScheduleWakeup は配送されません。ターンを終えた瞬間にプロセスごと終了し、待っていた処理は kill されます（2026-08-31 実害）。待たずに済むよう、時間のかかる処理は前景で `--timeout` 付きで実行してください。';
  } else if (/^(Bash|PowerShell)$/.test(tool) && input.tool_input?.run_in_background === true) {
    reason = 'ヘッドレス自動セッション（CLAUDE_HEADLESS=1）では run_in_background は使えません。ターン終了でプロセスツリーごと kill され、起動しただけで終わります（2026-08-31 実害: Codex が23秒で kill され PR ゼロ）。`run_in_background` を外し、前景で `--timeout <秒>` を付けて実行してください。';
  }
  if (!reason) process.exit(0);
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
} catch {}
