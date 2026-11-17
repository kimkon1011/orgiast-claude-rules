import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCodexAuthCommand, run } from './codex-auth-guard.mjs';

test('codex login / logout / device-auth は止める', () => {
  for (const cmd of ['codex login', 'codex login --device-auth', 'codex logout', 'wsl -d Ubuntu -- codex login --device-auth', 'cmd /c "codex.cmd login"', 'codex login --with-api-key', 'set BROWSER=none && codex login > out.txt'])
    assert.equal(evaluateCodexAuthCommand(cmd).decision, 'block', cmd);
});
test('状態確認・help・通常の codex 実行は通す', () => {
  for (const cmd of ['codex login status', 'wsl -d Ubuntu -u root -- codex login status', 'codex login --help', 'codex exec --skip-git-repo-check "ping"', 'codex --version', 'node tools/codex-do.mjs --task x', 'cat ~/.codex/auth.json.bak', 'git status'])
    assert.equal(evaluateCodexAuthCommand(cmd).decision, 'pass', cmd);
});
test('auth.json のコピー・削除・上書きは止める', () => {
  for (const cmd of ['cp ~/.codex/auth.json /mnt/c/x/', 'Remove-Item $HOME\\.codex\\auth.json', 'wsl -d Ubuntu -- sh -c \'cat > "$HOME/.codex/auth.json"\'', 'Copy-Item C:\\Users\\a\\.codex\\auth.json D:\\bk\\'])
    assert.equal(evaluateCodexAuthCommand(cmd).decision, 'block', cmd);
});
test('Bash / PowerShell 以外は対象外', () => {
  assert.equal(run({ tool_name: 'Write', tool_input: { command: 'codex logout' } }).decision, 'pass');
  assert.equal(run({ tool_name: 'PowerShell', tool_input: { command: 'codex logout' } }).decision, 'block');
});
