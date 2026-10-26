import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateExecTreeEditGuard } from './exec-tree-edit-guard.mjs';

const script = fileURLToPath(new URL('./exec-tree-edit-guard.mjs', import.meta.url));
const input = (tool_name, file) => ({ tool_name, tool_input: { [tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path']: file } });
const evaluate = (value, options = {}) => evaluateExecTreeEditGuard(value, { env: {}, ...options });

test('実行ツリーの編集4種は deny（os.homedir 基準）', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const output = evaluate(input(tool, `${os.homedir()}/orgiast-claude-rules/tools/file.mjs`));
    assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /git fetch origin/);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /onboarding-sync\.mjs --force/);
  }
});

test('Windows 区切り・大文字違い・混在区切りも deny', () => {
  for (const file of ['C:\\Users\\USER\\ORGIAST-CLAUDE-RULES\\tools\\file.mjs', 'c:/users/user/Orgiast-Claude-Rules/tools/file.mjs', 'C:\\Users/user\\orgiast-claude-rules/tools/file.mjs']) {
    assert.equal(evaluate(input('Edit', file), { home: 'C:\\Users\\user' }).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('nightly-repo・無関係パス・似た名前・対象外ツールは通す', () => {
  const home = os.homedir();
  for (const file of [`${home}/.claude/nightly-repo/tools/file.mjs`, '/tmp/file.mjs', `${home}/orgiast-claude-rules-other/file.mjs`, `${home}/other/orgiast-claude-rules/file.mjs`, `${home}/orgiast-claude-rules/../other/file.mjs`]) {
    assert.equal(evaluate(input('Write', file)), null);
  }
  assert.equal(evaluate(input('Read', `${home}/orgiast-claude-rules/file.mjs`)), null);
  for (const value of [null, {}, { tool_name: 'Write' }, input('Edit', 42)]) assert.equal(evaluate(value), null);
});

test('環境変数が1の場合だけ通す', () => {
  const value = input('Write', `${os.homedir()}/orgiast-claude-rules/file.mjs`);
  assert.equal(evaluate(value, { env: { ORGIAST_ALLOW_EXEC_TREE_EDIT: '1' } }), null);
  assert.equal(evaluate(value, { env: { ORGIAST_ALLOW_EXEC_TREE_EDIT: '0' } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('CLI は deny JSON を出力し、対象外・解除時・壊れたJSONは無出力で exit 0', () => {
  const value = JSON.stringify(input('Edit', `${os.homedir()}/orgiast-claude-rules/file.mjs`));
  for (const [raw, allow, denied] of [[value, '', true], [value, '1', false], ['{broken', '', false], ['null', '', false], [JSON.stringify(input('Write', '/tmp/file')), '', false]]) {
    const result = spawnSync(process.execPath, [script], { input: raw, encoding: 'utf8', env: { ...process.env, ORGIAST_ALLOW_EXEC_TREE_EDIT: allow } });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    if (denied) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    else assert.equal(result.stdout, '');
  }
});
