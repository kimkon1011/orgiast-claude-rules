import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDirtyWorktreeGuard } from './dirty-worktree-guard.mjs';
import { main } from './auto-session-launcher.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirty-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(repo);
  git(root, ['init', '--bare', remote]);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  fs.mkdirSync(path.join(repo, 'tools'));
  fs.writeFileSync(path.join(repo, 'tools', 'auto-session.mjs'), '');
  fs.writeFileSync(path.join(repo, 'tracked'), 'original');
  git(repo, ['add', 'tracked', 'tools/auto-session.mjs']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { root, repo, remote, git };
}

for (const pushFails of [false, true]) test(`dirty guard preserves and commits tracked/untracked changes; pushFails=${pushFails}`, (t) => {
  const { root, repo, remote, git } = fixture(t);
  fs.writeFileSync(path.join(repo, 'tracked'), 'changed');
  fs.writeFileSync(path.join(repo, 'untracked'), 'precious');
  if (pushFails) git(repo, ['remote', 'set-url', 'origin', path.join(root, 'missing')]);
  const logs = [];
  const guard = createDirtyWorktreeGuard({ home: root, log: s => logs.push(s) });
  assert.equal(guard(repo), false);
  assert.equal(guard(repo), false, 'rescue must not permit subsequent destructive steps');
  assert.equal(fs.readFileSync(path.join(repo, 'untracked'), 'utf8'), 'precious');
  const branch = git(repo, ['branch', '--show-current']).trim();
  assert.match(branch, /^rescue\/auto-session-\d{8}-\d{6}/);
  assert.equal(git(repo, ['show', `${branch}:tracked`]), 'changed');
  assert.equal(git(repo, ['show', `${branch}:untracked`]), 'precious');
  assert.match(fs.readFileSync(path.join(root, '.claude', 'next-session.md'), 'utf8'), /レビューが必要/);
  if (pushFails) assert.ok(logs.some(s => s.includes('RESCUE_PUSH_FAILED_LOCAL_SAVED')));
  else assert.equal(git(remote, ['show', `${branch}:untracked`]), 'precious');
});

test('status and commit errors fail closed and preserve untracked files', t => {
  const { root, repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, 'untracked'), 'precious');
  for (const failCommand of ['status', 'commit']) {
    const guard = createDirtyWorktreeGuard({ home: root, log: () => {}, git: (dir, args) => {
      if (args.includes(failCommand)) throw new Error('injected failure');
      return git(dir, args);
    } });
    assert.equal(guard(repo), false);
    assert.equal(guard(repo), false);
    assert.equal(fs.readFileSync(path.join(repo, 'untracked'), 'utf8'), 'precious');
  }
});

for (const dirty of [true, false]) test(`launcher real git integration: dirty=${dirty}`, async t => {
  const { root, repo, git } = fixture(t);
  const pinned = path.join(root, 'pinned');
  const oldFallback = `${pinned}-fallback-20000101-000000`;
  git(repo, ['worktree', 'add', '--detach', pinned, 'origin/main']);
  if (dirty) git(repo, ['worktree', 'add', '--detach', oldFallback, 'origin/main']);
  if (dirty) for (const dir of [repo, pinned, oldFallback]) {
    fs.writeFileSync(path.join(dir, 'tracked'), 'changed');
    fs.writeFileSync(path.join(dir, 'untracked'), 'precious');
  }
  if (!dirty) {
    git(repo, ['commit', '--allow-empty', '-m', 'upstream']);
    git(repo, ['push', 'origin', 'main']);
    git(repo, ['checkout', '--detach', 'HEAD~1']);
  }
  const previous = [process.env.ORGIAST_REPO, process.env.ORGIAST_AUTO_SESSION_TREE];
  process.env.ORGIAST_REPO = repo;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinned;
  t.after(() => {
    for (const [i, key] of ['ORGIAST_REPO', 'ORGIAST_AUTO_SESSION_TREE'].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  });
  const calls = [];
  const code = await main([], {
    allowUpdate: createDirtyWorktreeGuard({ home: root, log: () => {} }),
    readdir: () => dirty ? [path.basename(oldFallback)] : [], log: () => {}, bootLog: () => {},
    run: async (cmd, args, options) => {
      if (cmd !== 'git') return 0;
      calls.push({ args, cwd: options.cwd });
      try { return { code: 0, stdout: git(options.cwd, args) }; }
      catch (error) { return { code: 1, stderrTail: error.message }; }
    },
  });
  assert.equal(code, 0);
  if (dirty) {
    assert.equal(calls.some(c => c.args[0] === 'worktree' && c.args[1] === 'remove'), false);
    assert.equal(fs.readFileSync(path.join(oldFallback, 'untracked'), 'utf8'), 'precious');
    assert.equal(git(oldFallback, ['show', 'HEAD:untracked']), 'precious');
  }
  for (const dir of [repo, pinned]) {
    const destructive = calls.filter(c => c.cwd === dir && ['checkout', 'reset', 'clean'].includes(c.args[0]));
    assert.equal(destructive.length, dirty ? 0 : 3);
    if (dirty) {
      assert.equal(fs.readFileSync(path.join(dir, 'untracked'), 'utf8'), 'precious');
      assert.equal(git(dir, ['show', 'HEAD:tracked']), 'changed');
    } else assert.equal(git(dir, ['rev-parse', 'HEAD']), git(dir, ['rev-parse', 'origin/main']));
  }
});

test('recheck before each destructive command catches a new edit after checkout', async t => {
  const { root, repo, git } = fixture(t);
  const previous = [process.env.ORGIAST_REPO, process.env.ORGIAST_AUTO_SESSION_TREE];
  const pinned = path.join(root, 'pinned');
  process.env.ORGIAST_REPO = repo;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinned;
  t.after(() => {
    for (const [i, key] of ['ORGIAST_REPO', 'ORGIAST_AUTO_SESSION_TREE'].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  });
  const calls = [];
  await main([], {
    allowUpdate: createDirtyWorktreeGuard({ home: root, log: () => {} }),
    readdir: () => [], log: () => {}, bootLog: () => {},
    run: async (cmd, args, options) => {
      if (cmd !== 'git') return 0;
      calls.push({ args, cwd: options.cwd });
      git(options.cwd, args);
      if (options.cwd === repo && args[0] === 'checkout') fs.writeFileSync(path.join(repo, 'late-edit'), 'saved');
      return 0;
    },
  });
  assert.equal(calls.some(c => c.cwd === repo && ['reset', 'clean'].includes(c.args[0])), false);
  assert.equal(fs.readFileSync(path.join(repo, 'late-edit'), 'utf8'), 'saved');
  assert.equal(git(repo, ['show', 'HEAD:late-edit']), 'saved');
});

test('gitignored generated files do not trigger rescue', t => {
  const { root, repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'generated.json\n');
  git(repo, ['add', '.gitignore']);
  git(repo, ['commit', '-m', 'ignore generated']);
  fs.writeFileSync(path.join(repo, 'generated.json'), '{"builtAt":"x"}');
  const guard = createDirtyWorktreeGuard({ home: root, log: () => {} });
  assert.equal(guard(repo), true, 'ignored file must not dirty/block the tree');
  assert.equal(git(repo, ['branch', '--list', 'rescue/*']).trim(), '');
});

// 2026-10-13〜16 の実事故: git 強制終了の置き土産 .git/index.lock があると `git add -A` が
// `File exists.` で失敗し、救済ブランチだけ作られ commit ゼロ・worktree は dirty のまま固定。
// register-hooks の selectAnchor が anchor を見つけられず setup --converge が exit 1 になった。
test('残骸 index.lock を回収して救済を完遂する（worktree が clean に戻る）', t => {
  const { root, repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, 'tracked'), 'changed');
  fs.writeFileSync(path.join(repo, 'untracked'), 'precious');
  const lock = path.join(repo, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const stale = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  fs.utimesSync(lock, stale, stale);
  const logs = [];
  const guard = createDirtyWorktreeGuard({ home: root, log: s => logs.push(s) });
  assert.equal(guard(repo), false);
  assert.equal(fs.existsSync(lock), false, '残骸 lock は削除される');
  assert.ok(logs.some(s => s.includes('STALE_INDEX_LOCK_REMOVED')), '削除はログに残る');
  const branch = git(repo, ['branch', '--show-current']).trim();
  assert.match(branch, /^rescue\/auto-session-\d{8}-\d{6}/);
  assert.equal(git(repo, ['show', `${branch}:tracked`]), 'changed');
  assert.equal(git(repo, ['show', `${branch}:untracked`]), 'precious');
  assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']).trim(), '',
    '救済後は clean（selectAnchor が anchor として採用できる状態）');
});

test('閾値内の index.lock は稼働中とみなし削除しない（fail closed）', t => {
  const { root, repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, 'untracked'), 'precious');
  const lock = path.join(repo, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const logs = [];
  const guard = createDirtyWorktreeGuard({ home: root, log: s => logs.push(s) });
  assert.equal(guard(repo), false);
  assert.equal(fs.existsSync(lock), true, '新しい lock は残す');
  assert.ok(logs.some(s => s.includes('INDEX_LOCK_ACTIVE')));
  assert.ok(logs.some(s => s.includes('RESCUE_FAILED')), '救済は従来どおり失敗を記録する');
  assert.equal(fs.readFileSync(path.join(repo, 'untracked'), 'utf8'), 'precious');
  assert.equal(git(repo, ['log', '--oneline', '-1', '--all', '--grep=auto-session-rescue']).trim(), '');
});

test('stall-sweeper の実行時成果物は追跡されず gitignore される', t => {
  const { repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, '.gitignore'), fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'));
  fs.mkdirSync(path.join(repo, '.stall-sweeper'));
  fs.writeFileSync(path.join(repo, '.stall-sweeper', 'state.json'), '{}');
  assert.equal(git(repo, ['status', '--porcelain', '--untracked-files=all']).includes('.stall-sweeper'), false,
    '.stall-sweeper/ は worktree を dirty にしない（救済ブランチを作らせない）');
});

test('.fleet-ig-post/ の IG 投稿一時ファイルは追跡されず gitignore される', t => {
  const { repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, '.gitignore'), fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'));
  fs.mkdirSync(path.join(repo, '.fleet-ig-post'));
  fs.writeFileSync(path.join(repo, '.fleet-ig-post', 'part1.b64'), 'AAAA');
  fs.writeFileSync(path.join(repo, 'still-dirty'), 'x');
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all']);
  assert.equal(status.includes('.fleet-ig-post'), false,
    '.fleet-ig-post/ は worktree を dirty にしない（rescue の重複 PR churn を止める）');
  assert.ok(status.includes('still-dirty'), '他の untracked は従来どおり dirty（テストが空振りしていない）');
});

test('repo 直下の .tmp-* は追跡されず gitignore される', t => {
  const { repo, git } = fixture(t);
  fs.writeFileSync(path.join(repo, '.gitignore'), fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'));
  fs.writeFileSync(path.join(repo, '.tmp-extract-session.mjs'), 'x');
  fs.writeFileSync(path.join(repo, '.tmp-session-digest.txt'), 'inner context');
  fs.writeFileSync(path.join(repo, 'still-dirty'), 'x');
  const status = git(repo, ['status', '--porcelain', '--untracked-files=all']);
  assert.equal(status.includes('.tmp-'), false,
    '.tmp-* は worktree を dirty にしない（内部要約が rescue 枝で公開されるのを止める）');
  assert.ok(status.includes('still-dirty'), '他の untracked は従来どおり dirty（テストが空振りしていない）');
});

// 2026-10-21〜22 実測: この 5 つが ignore されていなかったため rescue 枝が毎時作られていた。
// どれか 1 つでも .gitignore から落ちると churn が戻るので、個別に固定する。
for (const dir of ['.landing', '.gate-rollout-check', '.expense-leak-evidence', '.scratch-lahaina', '.qwen']) {
  test(`repo 直下の ${dir}/ は追跡されず gitignore される`, t => {
    const { repo, git } = fixture(t);
    fs.writeFileSync(path.join(repo, '.gitignore'), fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'));
    fs.mkdirSync(path.join(repo, dir));
    fs.writeFileSync(path.join(repo, dir, 'artifact.bin'), 'machine-local');
    fs.writeFileSync(path.join(repo, 'still-dirty'), 'x');
    const status = git(repo, ['status', '--porcelain', '--untracked-files=all']);
    assert.equal(status.includes(dir), false,
      `${dir}/ は worktree を dirty にしない（救済ブランチの毎時 churn を止める）`);
    assert.ok(status.includes('still-dirty'), '他の untracked は従来どおり dirty（テストが空振りしていない）');
  });
}

test('routing-table.json は追跡されず gitignore される', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
  assert.equal(git('ls-files', '--', 'tools/routing-table.json'), '', 'routing-table.json must not be tracked');
  assert.equal(git('check-ignore', '--', 'tools/routing-table.json'), 'tools/routing-table.json', 'routing-table.json must be gitignored');
});
