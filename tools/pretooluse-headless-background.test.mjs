import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./pretooluse-headless-background.mjs', import.meta.url));

function run(input, headless) {
  const env = { ...process.env };
  if (headless === undefined) delete env.CLAUDE_HEADLESS;
  else env.CLAUDE_HEADLESS = headless;
  return spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env });
}

test('非ヘッドレスの ScheduleWakeup は許可する', () => {
  const result = run(JSON.stringify({ tool_name: 'ScheduleWakeup' }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('ヘッドレスの ScheduleWakeup は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'ScheduleWakeup' }), '1');
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('ヘッドレスの Bash バックグラウンド実行は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { run_in_background: true } }), '1');
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('ヘッドレスの前景 Bash は許可する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' } }), '1');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('壊れた JSON でも exit 0', () => {
  const result = run('{broken', '1');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
