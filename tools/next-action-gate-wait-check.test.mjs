import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeNextAction, WAIT_CHECK_CODES } from './next-action-gate.mjs';

delete process.env.CLAUDE_HEADLESS;
const raw = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
for (const [name, input] of [
  ['Bash', { run_in_background: true }], ['PowerShell', { run_in_background: true }],
  ['Agent', { run_in_background: true }], ['Bash', { command: 'codex exec "work"' }],
  ['Bash', { command: 'node tools/codex-do.mjs "work"' }], ['mcp__codex__codex', {}],
]) test(`フッター欠落でも待機違反を報告: ${name} ${JSON.stringify(input)}`, () => {
  const result = judgeNextAction('開始しました。', raw(name, input));
  assert.ok(result.reasonCodes.includes('NEXT-ACTION-FOOTER'));
  assert.ok(result.reasonCodes.includes('AUTOPILOT-IN-PROGRESS-NEEDS-CHECK'));
});
test('複数手渡しに隠さず4種の待機違反を同時報告する', () => {
  const text = '次に kim がすること: 入金、署名\nこの後の自動進行: 相手の返信後に作業を進め結果を報告します\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）';
  const result = judgeNextAction(text);
  assert.equal(result.code, 'NEXT-ACTION-MULTIPLE');
  assert.ok(result.reasonCodes.includes('NEXT-ACTION-MULTIPLE'));
  for (const code of WAIT_CHECK_CODES) {
    assert.ok(result.reasonCodes.includes(code), code);
    assert.ok(result.reason.includes(`[${code}]`), code);
  }
});
test('通常の同期コマンド、前ターン、sidechain は起動と誤認しない', () => {
  for (const transcript of [raw('Bash', { command: 'git status' }),
    raw('Bash', { run_in_background: true }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'ありがとう' } }),
    JSON.stringify({ isSidechain: true, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { run_in_background: true } }] } }),
  ]) assert.ok(!judgeNextAction('了解しました。', transcript).reasonCodes?.some(code => WAIT_CHECK_CODES.has(code)));
});
