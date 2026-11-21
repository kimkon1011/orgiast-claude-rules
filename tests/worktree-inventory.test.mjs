import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectWorktree, resolveWorktreePaths } from '../tools/worktree-inventory.mjs';

test('相対 gitdir と逆参照を確認できる作業ツリーを keep-repair にする', (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'wt-inventory-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = realpathSync.native(temp);
  const downloads = path.join(root, 'Downloads');
  const repo = path.join(downloads, 'repo');
  const repoAlias = path.join(root, 'repo');
  const worktree = path.join(downloads, 'linked');
  const displayPath = path.join(root, 'linked');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  mkdirSync(repo, { recursive: true });
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial', '--allow-empty');
  git('worktree', 'add', '-q', '--detach', worktree);
  symlinkSync(repo, repoAlias, 'junction');

  const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const adminDir = path.join(commonDir, 'worktrees', 'linked');
  const dotGit = path.join(worktree, '.git');
  const relative = (from, to) => path.relative(from, to).split(path.sep).join('/');
  writeFileSync(path.join(adminDir, 'gitdir'), `${relative(adminDir, dotGit)}\n`);
  const originalBacklink = readFileSync(dotGit, 'utf8');
  writeFileSync(dotGit, `gitdir: ${relative(worktree, adminDir)}\r\n`);

  // Model Git's display when it resolves against the repository alias.
  const listed = { path: displayPath };
  const inspect = (row) => {
    const [resolved] = resolveWorktreePaths(repoAlias, commonDir, [row]);
    return inspectWorktree(resolved, Date.now());
  };
  for (const prunable of [false, true]) {
    const row = inspect({ ...listed, prunable });
    assert.equal(row.category, 'keep-repair');
    assert.equal(row.path, displayPath);
    assert.equal(row.resolvedPath, worktree);
  }

  const [healthy] = resolveWorktreePaths(repoAlias, commonDir, [{ path: worktree }]);
  assert.equal(healthy.resolvedPath, undefined);
  writeFileSync(dotGit, `gitdir: ${commonDir}\n`);
  assert.equal(inspect(listed).category, 'prune');
  writeFileSync(dotGit, originalBacklink);
  assert.equal(inspect(listed).category, 'keep-repair');
  rmSync(dotGit);
  assert.equal(inspect(listed).category, 'prune');
});
