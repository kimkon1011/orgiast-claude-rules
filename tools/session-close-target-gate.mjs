export const GATE_CONTRACT = {"name": "session-close-target-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "session-close-target-gate"}]};

// 応答本文に close-session の案内（新しいタブ・/clear 等）があり、かつ
// close-session.mjs が同ターンで実行されているのに --show-target を実行していなければ block。
export function judge(text, toolUses) {
  // 逃がし弁
  if (text.includes('[LAUNCH-TARGET-OK]')) {
    return { decision: 'pass' };
  }

  // 同ターンの Bash/PowerShell ツール呼び出しから close-session.mjs を探す
  const bashCommands = (Array.isArray(toolUses) ? toolUses : [])
    .filter(b => b?.type === 'tool_use' && (b?.name === 'Bash' || b?.name === 'PowerShell'))
    .map(b => String(b?.input?.command || ''));

  const hasCloseSession = bashCommands.some(cmd => cmd.includes('close-session.mjs'));
  if (!hasCloseSession) {
    return { decision: 'pass' };
  }

  // close-session.mjs が呼ばれているのに --show-target が無ければ block
  const hasShowTarget = bashCommands.some(cmd => cmd.includes('--show-target'));
  if (!hasShowTarget) {
    return {
      decision: 'block',
      reason: '[LAUNCH-TARGET] /session-close の起動先案内をする前に next-session-launch.mjs --show-target を実行して起動先を確認してください。または [LAUNCH-TARGET-OK] を本文に書けばこのチェックをスキップできます。',
      code: 'LAUNCH-TARGET'
    };
  }

  return { decision: 'pass' };
}