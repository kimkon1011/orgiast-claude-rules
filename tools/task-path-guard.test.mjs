import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertStableTaskPath, isEphemeralPath } from './lib/task-path-guard.mjs';

test('isEphemeralPath is true for os.tmpdir() children', () => {
  const underTmp = path.join(os.tmpdir(), 'codex-do-cursor-agent-home', '.claude', 'nightly-repo');
  assert.equal(isEphemeralPath(underTmp), true);
  assert.equal(isEphemeralPath(os.tmpdir()), true);
});

test('isEphemeralPath is true for codex-do-cursor-agent-home segment', () => {
  assert.equal(isEphemeralPath('C:\\Users\\kimko\\AppData\\Local\\Temp\\codex-do-cursor-agent-home\\.claude\\nightly-repo'), true);
  assert.equal(isEphemeralPath('C:/Users/kimko/AppData/Local/Temp/codex-do-cursor-agent-home/.claude/nightly-repo'), true);
});

test('isEphemeralPath is true for AppData/Local/Temp with either separator', () => {
  assert.equal(isEphemeralPath('C:\\Users\\x\\AppData\\Local\\Temp\\foo'), true);
  assert.equal(isEphemeralPath('C:/Users/x/AppData/Local/Temp/foo'), true);
  assert.equal(isEphemeralPath('c:\\users\\x\\appdata\\local\\temp\\bar'), true);
});

test('isEphemeralPath is false for stable nightly-repo home', () => {
  assert.equal(isEphemeralPath('C:\\Users\\kimko\\.claude\\nightly-repo'), false);
  assert.equal(isEphemeralPath('C:/Users/kimko/.claude/nightly-repo'), false);
});

test('isEphemeralPath treats POSIX tmp prefixes as ephemeral', () => {
  assert.equal(isEphemeralPath('/tmp/codex-do-cursor-agent-home/.claude/nightly-repo'), true);
  assert.equal(isEphemeralPath('/var/folders/xx/yy/T/codex-do-cursor-agent-home'), true);
});

test('assertStableTaskPath throws with label and path', () => {
  assert.throws(
    () => assertStableTaskPath('C:\\Users\\x\\AppData\\Local\\Temp\\codex-do-cursor-agent-home\\repo', { label: 'repoRoot' }),
    /unstable task path \(repoRoot\).*temporary HOME/,
  );
  assert.equal(assertStableTaskPath('C:\\Users\\kimko\\.claude\\nightly-repo', { label: 'repoRoot' }), 'C:\\Users\\kimko\\.claude\\nightly-repo');
});
