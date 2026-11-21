import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./bash-cd-chain-guard.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./gate-hook-runner.mjs', import.meta.url));

function run(command, tool = 'Bash', args = [hook]) {
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

for (const command of ['cd a && b', 'cd "C:/x y"; npm test', 'cd ~/r || exit', 'cd ${HOME}/repo && git status', 'cd a#b && git status', 'cd "a && b" && git status', 'cd a\\;b; npm test']) {
  test(`denies ${command}`, () => {
    const output = JSON.parse(run(command)).hookSpecificOutput;
    assert.equal(output.hookEventName, 'PreToolUse');
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /ONBOARDING §1\.20/);
  });
}

for (const command of [
  'cd a', 'cd a;', 'cd && b', 'cd a; # comment', 'cd "a && b"', 'cd "$(echo "a && b")"', 'cd a\\;b',
  'git -C a status', 'echo "cd a && b"', 'bash -lc "cd a && b"', 'node x.mjs --cwd a',
  'pushd a && b', 'set -e; cd a && b', "cat <<'EOF'\ncd a && b\nEOF",
]) {
  test(`allows ${command}`, () => assert.equal(run(command), ''));
}

test('ignores non-Bash events', () => assert.equal(run('cd a && b', 'PowerShell'), ''));
test('enforces deny through the registered gate runner', () => {
  assert.equal(JSON.parse(run('cd a && b', 'Bash', [runner, hook])).hookSpecificOutput.permissionDecision, 'deny');
});
