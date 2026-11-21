import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rolloutMode } from './gate-runtime.mjs';
import { toolsDir } from './gate-contracts.mjs';

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
test('rolloutMode returns deny for pilot hostname', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(toolsDir, 'gate-rollout-manifest.json'), 'utf8'));
  assert.equal(rolloutMode('bash-cd-chain-guard', { hostname: manifest.pilotHosts[0] }), 'deny');
});
test('rolloutMode returns warn for non-pilot hostname before denyAfter', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-cd-guard-'));
  try {
    const now = new Date('2026-11-22T00:00:00Z').valueOf();
    assert.equal(rolloutMode('bash-cd-chain-guard', { home, hostname: 'ci-host', now }), 'warn');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('rolloutMode returns deny for non-pilot hostname after observation week', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-cd-guard-'));
  try {
    const firstSeen = new Date('2026-11-22T00:00:00Z').valueOf();
    const gateDir = path.join(home, '.claude', 'gate-rollout');
    fs.mkdirSync(gateDir, { recursive: true });
    fs.writeFileSync(path.join(gateDir, 'bash-cd-chain-guard.json'), JSON.stringify({ firstSeen }));
    const now = new Date('2026-12-06T00:00:00Z').valueOf();
    assert.equal(rolloutMode('bash-cd-chain-guard', { home, hostname: 'ci-host', now }), 'deny');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('runner output is non-empty (warn or deny)', () => {
  assert.ok(run('cd a && b', 'Bash', [runner, hook]).length > 0);
});
