const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { resolveClaudeShellPath } = require('./shell-path');

test('実在する絶対パスの claude または claude.exe だけを採用する', () => {
  assert.deepEqual(resolveClaudeShellPath('/opt/bin/Claude', () => true), { shellPath: '/opt/bin/Claude', ignored: false });
  assert.deepEqual(resolveClaudeShellPath('C:\\Tools\\CLAUDE.EXE', () => true, path.win32), { shellPath: 'C:\\Tools\\CLAUDE.EXE', ignored: false });
});

test('相対パス・別名・存在しないパスはPATH上のclaudeへフォールバックする', () => {
  for (const candidate of ['claude.exe', '/opt/bin/calc', '/opt/bin/claude']) {
    const exists = candidate !== '/opt/bin/claude';
    assert.deepEqual(resolveClaudeShellPath(candidate, () => exists), { shellPath: 'claude', ignored: true });
  }
  assert.deepEqual(resolveClaudeShellPath(null), { shellPath: 'claude', ignored: false });
});
