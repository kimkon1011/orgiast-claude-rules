import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirtyStatus, rescueTree } from './nightly-rescue.mjs';
import { snapshotTree, unstageUndeclaredGitlinks, supersededByMain } from './rescue-policy.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-rescue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const gitRun = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gitRun('init', '-b', 'main'); gitRun('config', 'user.name', 'Test'); gitRun('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'tracked'), 'original');
  gitRun('add', '.'); gitRun('commit', '-m', 'initial');
  gitRun('init', '--bare', path.join(root, 'remote.git')); gitRun('remote', 'add', 'origin', path.join(root, 'remote.git'));
  const messages = [], noticeOptions = [];
  const notify = async (message, options) => { messages.push(message); noticeOptions.push(options); return { delivered: 'dm' }; };
  const now = new Date(2026, 9, 9, 12).getTime();
  return { root, repo, home, git, gitRun, messages, noticeOptions, notify, now };
}
const branches = f => f.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/rescue/').trim().split('\n').filter(Boolean);

test('failed commit is attempted once per dirty status, including staging; retry after six hours', async t => {
  const f = fixture(t);
  const hook = path.join(f.repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "intentional commit failure" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  const first = await rescueTree(f.repo, f.home, f);
  assert.match(first.events.find(e => e.step === 'RESCUE_FAILED').message, /intentional commit failure/);
  const second = await rescueTree(f.repo, f.home, { ...f, now: f.now + 120000 });
  assert.equal(branches(f).length, 1);
  assert.ok(second.events.some(e => e.step === 'RESCUE_THROTTLED'));
  assert.equal(f.messages.length, 0);
  await rescueTree(f.repo, f.home, { ...f, now: f.now + 6 * 3600000 });
  assert.equal(branches(f).length, 2);
});

test('scratch and nested git directories/files are ignored; real changes are rescued without them', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.gitignore'), 'scratch/\n');
  f.gitRun('add', '.gitignore'); f.gitRun('commit', '-m', 'ignore scratch');
  fs.mkdirSync(path.join(f.repo, 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'scratch', 'result'), 'precious');
  f.gitRun('init', path.join(f.repo, 'nested clone'));
  fs.writeFileSync(path.join(f.repo, 'nested clone', 'file'), 'nested');
  f.gitRun('worktree', 'add', '--detach', path.join(f.repo, 'linked clone'));
  assert.equal(dirtyStatus(f.repo).clean, true);
  assert.equal((await rescueTree(f.repo, f.home, f)).clean, true);
  assert.equal(branches(f).length, 0);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'real change');
  await rescueTree(f.repo, f.home, f);
  assert.equal(branches(f).length, 1);
  assert.equal(f.git('show', 'HEAD:tracked'), 'real change');
  assert.equal(f.git('ls-tree', '--name-only', 'HEAD'), '.gitignore\ntracked\n');
  assert.equal(f.messages.length, 1);
  f.gitRun('clean', '-qfd', '-e', 'scratch/');
  assert.equal(fs.readFileSync(path.join(f.repo, 'scratch', 'result'), 'utf8'), 'precious');
  assert.ok(fs.existsSync(path.join(f.repo, 'nested clone', '.git')));
  assert.ok(fs.existsSync(path.join(f.repo, 'linked clone', '.git')));
});

test('successful rescues use one fixed key and refresh the complete branch list', async t => {
  const f = fixture(t);
  for (const [i, offset] of [0, 120000, 86400000].entries()) {
    fs.writeFileSync(path.join(f.repo, `new-${i}`), 'change');
    await rescueTree(f.repo, f.home, { ...f, now: f.now + offset });
  }
  assert.equal(branches(f).length, 3);
  assert.equal(f.messages.length, 3);
  assert.ok(f.noticeOptions.every(options => options.dedupeKey === 'rescue-branch-review' && options.replaceExisting === true && options.incrementExisting === true));
  assert.match(f.messages.at(-1), /計 3 件/);
  for (const branch of branches(f)) assert.match(f.messages.at(-1), new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('three failures in an hour send one loop notification, not a rescue notification', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(f.repo, `change-${i}`), 'change');
    await rescueTree(f.repo, f.home, { ...f, now: f.now + i * 120000 });
  }
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /夜間の自動復旧が 1 時間に 3 回失敗/);
  assert.match(f.messages[0], /次に自動でやること: 明日の夜間バッチ/);
  assert.match(f.messages[0], /kim がすること: なし/);
});

test('legacy bootstrap failure log also triggers a single loop notification', async t => {
  const f = fixture(t);
  const logs = path.join(f.home, '.claude', 'logs'); fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'nightly-bootstrap-2026-10-09.log'), '2026-10-09 12:00:00 / RESCUE_FAILED / commit failed\n'.repeat(3));
  await rescueTree(f.repo, f.home, f); await rescueTree(f.repo, f.home, f);
  assert.equal(f.messages.length, 1);
});

test('unreadable state fails closed without making a branch', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.claude')); fs.writeFileSync(path.join(f.home, '.claude', 'nightly-rescue-state.json'), 'broken');
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  assert.equal((await rescueTree(f.repo, f.home, f)).clean, false);
  assert.equal(branches(f).length, 0);
});

 test('literal staging handles renames, deletions and pathspec-looking filenames', async t => {
  const f = fixture(t);
  fs.renameSync(path.join(f.repo, 'tracked'), path.join(f.repo, 'renamed file'));
  f.gitRun('add', '-A');
  fs.writeFileSync(path.join(f.repo, '[literal]'), 'keep');
  const snapshot = snapshotTree(f.repo, dirtyStatus(f.repo));
  const result = await rescueTree(f.repo, f.home, f);
  assert.equal(f.git('rev-parse', 'HEAD^{tree}').trim(), snapshot);
  assert.ok(result.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(result.events));
  assert.equal(f.git('show', 'HEAD:renamed file'), 'original');
  assert.equal(f.git('show', 'HEAD:[literal]'), 'keep');
  assert.equal(f.git('ls-tree', '--name-only', 'HEAD').includes('tracked'), false);
});

for (const staged of [false, true]) test(`rescues a deletion: staged=${staged}`, async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.repo, 'tracked'));
  if (staged) f.gitRun('add', '-A');
  const snapshot = snapshotTree(f.repo, dirtyStatus(f.repo));
  const result = await rescueTree(f.repo, f.home, f);
  assert.equal(f.git('rev-parse', 'HEAD^{tree}').trim(), snapshot);
  assert.ok(result.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(result.events));
  assert.equal(f.git('ls-tree', '--name-only', 'HEAD'), '');
});

test('preserved-tree rescues skip a snapshot tree a rescue branch already holds', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  const first = await rescueTree(f.repo, f.home, { ...f, preserveTree: true });
  assert.ok(first.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(first.events));
  assert.equal(branches(f).length, 1);
  // Same dirty content after the six-hour throttle expires: no new branch.
  const second = await rescueTree(f.repo, f.home, { ...f, preserveTree: true, now: f.now + 6 * 3600000 });
  assert.ok(second.events.some(e => e.step === 'RESCUE_DUPLICATE'), JSON.stringify(second.events));
  assert.equal(branches(f).length, 1);
  // A genuinely different snapshot still gets its own branch.
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'different');
  const third = await rescueTree(f.repo, f.home, { ...f, preserveTree: true, now: f.now + 12 * 3600000 });
  assert.ok(third.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(third.events));
  assert.equal(branches(f).length, 2);
});


test('共有index.lockがあっても専用indexで保全し既存ロックを削除しない', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'valuable change');
  const lock = path.join(f.repo, '.git/index.lock'); fs.writeFileSync(lock, 'another process');
  const head = f.git('rev-parse', 'HEAD');
  const result = await rescueTree(f.repo, f.home, f);
  assert.ok(result.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(result));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another process');
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('show', `${branches(f).find(b => b.endsWith('-snapshot'))}:tracked`), 'valuable change');
  assert.match(f.messages[0], /原因:.*index.lock/);
  assert.match(f.messages[0], /対処:.*専用インデックス/);
});

test('5分より古い index.lock は残骸として消し、通常の退避コミットに進む', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'valuable change');
  const lock = path.join(f.repo, '.git/index.lock'); fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 2 * 24 * 3600000);
  fs.utimesSync(lock, old, old);
  const result = await rescueTree(f.repo, f.home, f);
  assert.ok(result.events.some(e => e.step === 'STALE_INDEX_LOCK'), JSON.stringify(result.events));
  assert.ok(result.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(result.events));
  assert.equal(fs.existsSync(lock), false);
  assert.ok(!branches(f).some(b => b.endsWith('-snapshot')), branches(f).join(','));
  assert.equal(f.git('show', 'HEAD:tracked'), 'valuable change');
});

test('auto-session rescues skip a snapshot tree a rescue branch already holds', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  const snapshot = snapshotTree(f.repo, dirtyStatus(f.repo));
  const first = await rescueTree(f.repo, f.home, f);
  assert.ok(first.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(first.events));
  assert.equal(f.git('rev-parse', 'HEAD^{tree}').trim(), snapshot);
  assert.equal(branches(f).length, 1);
  const handoff = path.join(f.home, '.claude', 'next-session.md');
  const before = fs.readFileSync(handoff, 'utf8');
  const messages = [...f.messages];
  f.gitRun('switch', 'main');
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  const status = f.git('status', '--porcelain');
  const second = await rescueTree(f.repo, f.home, { ...f, now: f.now + 6 * 3600000 });
  assert.ok(second.events.some(e => e.step === 'RESCUE_DUPLICATE'), JSON.stringify(second.events));
  assert.equal(branches(f).length, 1);
  assert.equal(f.git('branch', '--show-current').trim(), 'main');
  assert.equal(f.git('status', '--porcelain'), status);
  assert.equal(fs.readFileSync(handoff, 'utf8'), before);
  assert.deepEqual(f.messages, messages);
  assert.equal(f.git('ls-remote', '--heads', 'origin', 'refs/heads/rescue/*').trim().split('\n').length, 1);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'different');
  const third = await rescueTree(f.repo, f.home, { ...f, now: f.now + 12 * 3600000 });
  assert.ok(third.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(third.events));
  assert.equal(branches(f).length, 2);
});

test('unstageUndeclaredGitlinks removes a gitlink that is not a declared submodule', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-gitlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const gitRun = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gitRun('init', '-b', 'main');
  gitRun('config', 'user.name', 'Test');
  gitRun('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'tracked'), 'original');
  gitRun('add', '.'); gitRun('commit', '-m', 'initial');
  // Create a nested git repo inside the parent (gitlink candidate).
  fs.mkdirSync(path.join(repo, 'nested'));
  const ngitRun = (...args) => execFileSync('git', ['-C', path.join(repo, 'nested'), ...args], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  const ngit = (...args) => execFileSync('git', ['-C', path.join(repo, 'nested'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ngitRun('init', '-b', 'main');
  ngitRun('config', 'user.name', 'Test');
  ngitRun('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'nested', 'file'), 'content');
  ngitRun('add', '.'); ngitRun('commit', '-m', 'nested initial');
  // Stage the nested repo — this creates a gitlink (mode 160000) in the index.
  gitRun('add', '--', 'nested');
  const before = git('ls-files', '--stage');
  assert.ok(before.split(/\r?\n/).some(line => line.startsWith('160000 ')), 'gitlink should be staged');
  // Call the function.
  const dropped = unstageUndeclaredGitlinks(repo);
  assert.ok(dropped.includes('nested'), `dropped should include 'nested', got: ${JSON.stringify(dropped)}`);
  const after = git('ls-files', '--stage');
  assert.equal(after.split(/\r?\n/).filter(Boolean).filter(line => line.startsWith('160000 ')).length, 0,
    `160000 entries should be empty, got: ${after}`);
});

test('supersededByMain: main 履歴に同一内容があるブランチだけ true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superseded-'));
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't @example.com');
    run('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    run('add', '-A'); run('commit', '-qm', 'v1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n');
    run('add', '-A'); run('commit', '-qm', 'v2');
    run('update-ref', 'refs/remotes/origin/main', run('rev-parse', 'HEAD').trim());

    // 古い版へ戻しただけの rescue = main 履歴に同一 blob がある
    run('switch', '-qc', 'rescue/x');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
    run('add', '-A'); run('commit', '-qm', 'stale copy');
    assert.equal(supersededByMain(dir, run('rev-parse', 'HEAD').trim()), true);

    // main に一度も存在しないファイルが混じれば false
    fs.writeFileSync(path.join(dir, 'b.txt'), 'stray\n');
    run('add', '-A'); run('commit', '-qm', 'stray file');
    assert.equal(supersededByMain(dir, run('rev-parse', 'HEAD').trim()), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('supersededByMain: blob が main 履歴に無くても追加行ゼロなら true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superset-'));
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't @example.com');
    run('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    run('add', '-A'); run('commit', '-qm', 'base');
    // main だけが進んだ無関係ファイルは判定に混ぜない（全ツリー比較の退行ガード）
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'main only\nsecond line\n');
    run('add', '-A'); run('commit', '-qm', 'main advances elsewhere');
    run('update-ref', 'refs/remotes/origin/main', run('rev-parse', 'HEAD').trim());

    // main の一部を消しただけの版 = main に無い行をひとつも持たない
    run('switch', '-qc', 'rescue/subset', 'HEAD~1');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nthree\n');
    run('add', '-A'); run('commit', '-qm', 'older local copy');
    assert.equal(supersededByMain(dir, run('rev-parse', 'HEAD').trim()), true);

    // main に無い行を1行でも足せば false
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nthree\nfour\n');
    run('add', '-A'); run('commit', '-qm', 'adds a line');
    assert.equal(supersededByMain(dir, run('rev-parse', 'HEAD').trim()), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
