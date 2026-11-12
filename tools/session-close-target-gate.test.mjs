import assert from 'node:assert/strict';
import test from 'node:test';
import { judge } from './session-close-target-gate.mjs';

function bashTool(command) {
  return { type: 'tool_use', name: 'Bash', input: { command } };
}

function psTool(command) {
  return { type: 'tool_use', name: 'PowerShell', input: { command } };
}

test('close-session.mjs 実行＋--show-target 無し → block', () => {
  const result = judge('次に kim がすること: 自動で開いた新しいタブで Enter を1回押してください', [
    bashTool('node ~/.claude/nightly-repo/tools/close-session.mjs --session abc123'),
  ]);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /\[LAUNCH-TARGET\]/);
});

test('close-session.mjs 実行＋--show-target 有り → pass', () => {
  const result = judge('次に kim がすること: 自動で開いた新しいタブで Enter を1回押してください', [
    bashTool('node ~/.claude/nightly-repo/tools/close-session.mjs --session abc123'),
    bashTool('node tools/next-session-launch.mjs --show-target'),
  ]);
  assert.equal(result.decision, 'pass');
});

test('close-session.mjs を実行していない → pass', () => {
  const result = judge('次に kim がすること: なし', []);
  assert.equal(result.decision, 'pass');
});

test('逃がし弁 [LAUNCH-TARGET-OK] → pass', () => {
  const result = judge('ここに [LAUNCH-TARGET-OK] と書いてあるので close-session の起動先確認は不要です。\n次に kim がすること: 自動で開いた新しいタブで Enter を1回押してください', [
    bashTool('node ~/.claude/nightly-repo/tools/close-session.mjs --session abc123'),
  ]);
  assert.equal(result.decision, 'pass');
});

test('PowerShell で close-session.mjs 実行＋--show-target 無し → block', () => {
  const result = judge('次に kim がすること: このタブで /clear', [
    psTool('node ~/.claude/nightly-repo/tools/close-session.mjs --session abc123'),
  ]);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /\[LAUNCH-TARGET\]/);
});

test('PowerShell で close-session.mjs ＋--show-target → pass', () => {
  const result = judge('次に kim がすること: このタブで /clear', [
    psTool('node ~/.claude/nightly-repo/tools/close-session.mjs --session abc123'),
    psTool('node tools/next-session-launch.mjs --show-target'),
  ]);
  assert.equal(result.decision, 'pass');
});

test('toolUses が空配列でもエラーにならない', () => {
  const result = judge('通常の応答です。');
  assert.equal(result.decision, 'pass');
});