import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pretooluse-codex-invocation.mjs');
function run(command, toolName = 'Bash') {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8',
  });
}

test('recommended prompt-file invocation produces no output', () => {
  const result = run('node "/repo/tools/codex-do.mjs" --prompt-file prompt.md --cwd /repo --timeout 1800');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('detects argv prompt', () => {
  const output = run('codex exec "implement this" --timeout 1800').stdout;
  assert.match(output, /argv-prompt/);
  assert.doesNotMatch(output, /no-timeout/);
});

test('detects bash -lc wrapper', () => {
  assert.match(run('bash -lc \'codex exec - < prompt.md\' --timeout 1800').stdout, /shell-wrapped/);
});

test('detects piped output', () => {
  assert.match(run('codex exec - < prompt.md --timeout 1800 | tail -40').stdout, /piped-output/);
});

test('detects missing timeout', () => {
  assert.match(run('codex exec - < prompt.md').stdout, /no-timeout/);
});

test('irrelevant command and non-shell tool produce no output', () => {
  assert.equal(run('git status').stdout, '');
  assert.equal(run('codex exec "implement this"', 'Write').stdout, '');
});

test('detects backticks in argv and accepts direct safe invocation', () => {
  assert.match(run('codex exec "edit `tools/a.mjs`" --timeout 1800').stdout, /backtick-in-argv/);
  assert.equal(run('wsl -d Ubuntu --cd "/repo" -- timeout 1800 codex exec -s workspace-write - < prompt.md').stdout, '');
});

test('broken stdin exits zero without output', () => {
  const result = spawnSync(process.execPath, [script], { input: '{broken', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('codex-do.mjs は --timeout 省略でも警告しない（既定1800秒を内蔵しているため）', () => {
  assert.equal(run('node "/repo/tools/codex-do.mjs" --prompt-file /tmp/p.md --cwd /repo').stdout, '');
});

test('素の codex exec は --timeout 省略を警告する', () => {
  assert.match(run('codex exec - < prompt.md').stdout, /no-timeout/);
});
