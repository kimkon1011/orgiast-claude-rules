import test from 'node:test';
import assert from 'node:assert/strict';
import { isUserFacingPrompt, isPastLogSearchToolUse } from './user-facing.mjs';
test('操作と判断を検出し通常実装と分ける', () => {
  for (const prompt of ['この画面で次どこ押せばいい？ [Image #1]', 'a.PNG', 'どっちがおすすめ']) assert.equal(isUserFacingPrompt(prompt), true);
  assert.equal(isUserFacingPrompt('hook を実装して'), false);
});
test('検索先・skill・委譲内容から過去ログ参照を判定する', () => {
  for (const [name, input] of [['Grep', { path: 'C:\\Users\\x\\.claude\\projects' }], ['Glob', { pattern: '~/.claude/playbooks/*.md' }], ['Read', { file_path: '/x/memory/a.md' }], ['Skill', { skill: 'find-session' }], ['PowerShell', { command: 'Select-String memory MacroDroid' }], ['Bash', { command: 'rg MacroDroid ~/.claude/projects' }], ['Agent', { prompt: '過去ログを検索' }], ['Task', { prompt: 'memory を検索' }]]) assert.equal(isPastLogSearchToolUse(name, input), true, name);
  assert.equal(isPastLogSearchToolUse('Grep', { path: '/repo/src' }), false); assert.equal(isPastLogSearchToolUse('Read', null), false);
});
