import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./pretooluse-claude-docs-guard.mjs', import.meta.url));
const prefix = 'mcp__claude_ai_Claude_Docs__';
function invoke(input) {
  const result = spawnSync(process.execPath, [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('create と batch container.create を deny する', () => {
  for (const input of [
    { tool_name: `${prefix}create`, tool_input: {} },
    { tool_name: `${prefix}batch`, tool_input: { container: { create: { title: '手順書' } } } },
    { tool_name: `${prefix}batch`, tool_input: { container: { create: {}, update: {} } } },
  ]) {
    const output = JSON.parse(invoke(input)).hookSpecificOutput;
    assert.equal(output.hookEventName, 'PreToolUse');
    assert.equal(output.permissionDecision, 'deny');
    for (const text of ['[CLAUDE-DOCS-GUARD]', 'Google ドキュメント', 'contentMimeType: text/html', 'get_file_permissions', 'docs.google.com/a/orgiast.jp/document/d/{ID}/edit', 'user が明示的に Claude Docs']) {
      assert.ok(output.permissionDecisionReason.includes(text), text);
    }
  }
});

test('既存文書の update/read/guide/query と他ツールは通過する', () => {
  for (const operation of ['update', 'read', 'guide', 'query']) {
    assert.equal(invoke({ tool_name: `${prefix}${operation}`, tool_input: {} }), '');
    assert.equal(invoke({ tool_name: `${prefix}batch`, tool_input: { container: { [operation]: {} } } }), '');
  }
  assert.equal(invoke({ tool_name: 'other__batch', tool_input: { container: { create: {} } } }), '');
});

test('不正JSON・欠落・想定外の入力は fail-open', () => {
  for (const input of ['', '{', 'null', '[]', '{}',
    { tool_name: `${prefix}batch` },
    { tool_name: `${prefix}batch`, tool_input: null },
    { tool_name: `${prefix}batch`, tool_input: { container: 'create' } },
    { tool_name: `${prefix}batch`, tool_input: { container: null } },
  ]) assert.equal(invoke(input), '');
});

test('register-hooks は matcher/timeout を保ち2回実行しても1本だけ登録する', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'register-claude-docs-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [path.join(repo, 'tools/register-hooks.mjs'), '--hooks-only'], {
      encoding: 'utf8', timeout: 20000, env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  const matches = settings.hooks.PreToolUse.flatMap(group => (group.hooks || [])
    .filter(item => item.command.includes('pretooluse-claude-docs-guard.mjs'))
    .map(item => ({ matcher: group.matcher, ...item })));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matcher, `${prefix}.*`);
  assert.equal(matches[0].timeout, 5);
});
