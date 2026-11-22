import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyWorktree, inspectWorktree, resolveWorktreePaths } from './worktree-inventory.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-21T12:00:00Z');
const base = {
  path: '/tmp/worktree',
  branch: 'feat/example',
  exists: true,
  now,
  updatedAt: now - DAY_MS - 1,
  ancestor: true,
};

const fixtures = [
  ['メインが保護と prune に優先する', { main: true, path: '/nightly-repo', prunable: true }, 'keep-main'],
  ['夜間用パスが prune に優先する', { path: '/nightly-repo-fleet', prunable: true }, 'keep-protected'],
  ['自動セッション用リポジトリを保護する', { path: '/tmp/auto-session-repo' }, 'keep-protected'],
  ['自動セッション用ツリーを保護する', { path: '/tmp/auto-session-tree-2' }, 'keep-protected'],
  ['Windows の配布リポジトリを保護する', { path: 'C:\\Users\\kim\\Downloads\\orgiast-claude-rules' }, 'keep-protected'],
  ['orgiast-main ディレクトリそのものを保護する', { path: 'C:/Users/orgiast-main' }, 'keep-protected'],
  ['orgiast-main 配下を保護する', { path: 'C:/Users/orgiast-main/worktree' }, 'keep-protected'],
  ['orgiast-main の接尾辞付きディレクトリは別に扱う', { path: 'C:/Users/orgiast-main-old' }, 'safe'],
  ['別の親を持つ orgiast-main は別に扱う', { path: 'C:/Users/kim/orgiast-main' }, 'safe'],
  ['Git が prunable とした行を分類する', { prunable: true, dirty: true }, 'prune'],
  ['実体のない行を分類する', { exists: false }, 'prune'],
  ['変更ありを更新時刻より優先する', { dirty: true, updatedAt: now }, 'keep-dirty'],
  ['24時間ちょうどを直近に含める', { updatedAt: now - DAY_MS, ancestor: false }, 'keep-recent'],
  ['祖先判定が偽でPRを調べない場合は保持する', { ancestor: false }, 'keep-unpushed'],
  ['マージ済みPRがない場合は保持する', { ancestor: false, mergedPr: false }, 'keep-unpushed'],
  ['祖先にあれば削除候補にする', {}, 'safe'],
  ['マージ済みPRがあれば削除候補にする', { ancestor: false, mergedPr: true }, 'safe'],
  ['履歴外の detached HEAD を保持する', { ancestor: false, branch: undefined }, 'keep-unpushed'],
  ['履歴内の detached HEAD を削除候補にする', { branch: undefined }, 'safe'],
  ['点検失敗の行を保持する', { error: 'git status に失敗' }, 'keep-error'],
];

for (const [name, overrides, expected] of fixtures) {
  test(name, () => {
    const { category, reason } = classifyWorktree({ ...base, ...overrides });
    assert.equal(category, expected);
    assert.match(reason, /[ぁ-んァ-ン一-龯].*。$/u);
  });
}

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
  // Git for Windows creates a hidden file, which cannot be opened with 'w'.
  rmSync(dotGit);
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
