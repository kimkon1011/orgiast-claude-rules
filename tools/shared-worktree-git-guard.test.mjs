import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runHook } from './gate-hook-runner.mjs';
import { classifyGitCommand } from './shared-worktree-git-guard.mjs';

const hook = fileURLToPath(new URL('./shared-worktree-git-guard.mjs', import.meta.url));

test('操作の種類とパス指定を判定する', () => {
  const cases = [
    ['git add tools/a.mjs', null],
    ['git add -- -A', null],
    ['git add -A', 'add-all'],
    ['git add --all', 'add-all'],
    ['git add .', 'add-all'],
    ['git add -u', 'add-all'],
    ['git commit -F m -- a b', null],
    ['git commit --amend -F m -- a', null],
    ['git commit -m x tools/a.mjs', null],
    ['git commit -m x', 'commit-no-pathspec'],
    ['git commit --amend --no-edit', 'commit-no-pathspec'],
    ['git commit -m "a; b" --', 'commit-no-pathspec'],
    ['git commit --author "a <a@example.test>" -m x > log', 'commit-no-pathspec'],
    ['git commit -am x', 'commit-all'],
    ['git commit --all -m x', 'commit-all'],
    ['git stash list', null],
    ['git stash show -p', null],
    ...['', 'push', 'save', 'pop', 'apply', 'drop', 'clear'].map(subcommand => [`git stash ${subcommand}`, 'stash']),
    ['git -C x stash pop', 'stash'],
    ['echo "git add -A; git stash"', null],
    ['git add -A; git status', 'add-all'],
    ['git status && git stash', 'stash'],
    ['git status | git add .', 'add-all'],
    ['git status\ngit commit -m x', 'commit-no-pathspec'],
    ['& "C:\\Program Files\\Git\\bin\\git.exe" add -A', 'add-all'],
  ];

  for (const [command, violation] of cases) {
    assert.deepEqual(classifyGitCommand(command), { violation }, command);
  }
});

test('実リポジトリの本体だけを拒否し、cwd、cd、git -C を解決する', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-worktree-git-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main repo');
  const linked = path.join(root, 'linked repo');
  fs.mkdirSync(main);

  const env = { ...process.env, ORGIAST_SHARED_WORKTREES: '' };
  function git(...args) {
    const result = spawnSync('git', ['-C', main, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
  }
  function decision(cwd, command, overrides = {}) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      env: { ...env, ...overrides },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
  }

  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgSign=false',
      'commit', '--allow-empty', '-qm', 'initial');
  assert.equal(decision(main, 'git add -A'), null);

  const alias = path.join(root, 'main alias');
  fs.symlinkSync(main, alias, 'junction');
  const configured = { ORGIAST_SHARED_WORKTREES: `${root};${alias}` };
  assert.equal(decision(main, 'git stash', configured).permissionDecision, 'deny');

  git('worktree', 'add', '-qb', 'isolated', linked);
  const denial = decision(main, 'git add -A');
  assert.equal(denial.permissionDecision, 'deny');
  assert.match(denial.permissionDecisionReason, /git commit -F <msg> -- <自分のパス>/);
  assert.match(denial.permissionDecisionReason, /git worktree add -b/);
  assert.match(denial.permissionDecisionReason, /git show --stat --format="" HEAD/);
  assert.equal(decision(linked, 'git add -A'), null);
  assert.equal(decision(linked, 'git stash', { ORGIAST_SHARED_WORKTREES: linked }), null);
  assert.equal(decision(main, 'git commit -F m -- a b'), null);
  assert.equal(decision(linked, 'git -C "../main repo" stash pop').permissionDecision, 'deny');
  assert.equal(decision(main, 'cd "../linked repo" && git stash'), null);
  assert.equal(decision(root, 'cd "linked repo" && git stash; git -C "../main repo" add .').permissionDecision, 'deny');
  assert.equal(decision(main, 'git -C missing add -A'), null);

  const registered = await runHook(hook, JSON.stringify({
    cwd: main, tool_name: 'PowerShell', tool_input: { command: 'git stash; git status' },
  }), {
    env,
    policyOptions: {
      home: root,
      hostname: 'non-pilot-test',
      notify: async () => ({ delivered: 'test' }),
    },
  });
  assert.equal(JSON.parse(registered.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
