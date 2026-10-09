import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncTree } from './sync-orgiast-main.mjs';
import { dirtyStatus, rescueTree } from './rescue-policy.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-main-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'tracked'), 'original');
  git('add', '.'); git('commit', '-m', 'initial');
  git('init', '--bare', path.join(root, 'remote.git')); git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  git('push', '-u', 'origin', 'main');
  const messages = [];
  const notify = async (message, options) => { messages.push({ message, options }); return { delivered: 'dm' }; };
  return { root, repo, home, git, messages, notify, pc: 'test-PC', now: new Date(2026, 9, 9, 12).getTime() };
}
const branches = f => f.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/rescue/').trim().split('\n').filter(Boolean);

test('same dirty status creates one remote branch, preserving HEAD, index and worktree; retries at six hours', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'staged'); f.git('add', 'tracked');
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'unstaged');
  fs.writeFileSync(path.join(f.repo, 'untracked'), 'precious');
  const before = f.git('status', '--porcelain=v1', '-z');
  const index = fs.readFileSync(path.join(f.repo, '.git', 'index'));
  const head = f.git('rev-parse', 'HEAD');
  const first = await syncTree(f.repo, f.home, f);
  assert.equal(first.clean, false);
  assert.ok(first.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(first));
  const second = await syncTree(f.repo, f.home, { ...f, now: f.now + 3600000 });
  assert.ok(second.events.some(e => e.step === 'RESCUE_THROTTLED'));
  assert.equal(branches(f).length, 1);
  assert.equal(f.git('ls-remote', '--heads', 'origin', 'rescue/*').trim().split('\n').length, 1);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('branch', '--show-current').trim(), 'main');
  assert.equal(f.git('status', '--porcelain=v1', '-z'), before);
  assert.deepEqual(fs.readFileSync(path.join(f.repo, '.git', 'index')), index);
  assert.equal(f.git('show', `${branches(f)[0]}:tracked`), 'unstaged');
  assert.equal(f.git('show', `${branches(f)[0]}:untracked`), 'precious');
  assert.equal(f.messages.length, 0);
  await syncTree(f.repo, f.home, { ...f, now: f.now + 6 * 3600000 });
  assert.equal(branches(f).length, 2);
});

test('shared exclusions alone are clean, retained during sync and absent from rescue', async t => {
  const f = fixture(t);
  for (const name of ['scratch', '.work-eval', '.fleet-mail-work']) {
    fs.mkdirSync(path.join(f.repo, name)); fs.writeFileSync(path.join(f.repo, name, 'keep'), 'precious');
  }
  f.git('init', path.join(f.repo, 'nested clone'));
  fs.writeFileSync(path.join(f.repo, 'nested clone', 'keep'), 'precious');
  assert.equal(dirtyStatus(f.repo).clean, true);
  assert.equal((await rescueTree(f.repo, f.home, f)).clean, true);
  assert.equal((await syncTree(f.repo, f.home, f)).clean, true);
  assert.equal(branches(f).length, 0);
  for (const name of ['scratch', '.work-eval', '.fleet-mail-work', 'nested clone']) {
    assert.equal(fs.readFileSync(path.join(f.repo, name, 'keep'), 'utf8'), 'precious');
  }
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  await syncTree(f.repo, f.home, f);
  assert.equal(f.git('ls-tree', '--name-only', branches(f)[0]), 'tracked\n');
});

test('dirty for 24 hours sends only PC, tree and count once daily; clean resets duration', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  for (const hours of [0, 23, 24, 25]) await syncTree(f.repo, f.home, { ...f, now: f.now + hours * 3600000 });
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].message, `PC: test-PC\nTree: ${f.repo}\nDirty paths: 1`);
  assert.equal(f.messages[0].options.webhookFallback, false);
  await syncTree(f.repo, f.home, { ...f, now: f.now + 48 * 3600000 });
  assert.equal(f.messages.length, 2);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'original');
  await syncTree(f.repo, f.home, { ...f, now: f.now + 49 * 3600000 });
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'new');
  await syncTree(f.repo, f.home, { ...f, now: f.now + 72 * 3600000 });
  assert.equal(f.messages.length, 2);
});

test('old nightly state fingerprints throttle hourly sync too', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'changed');
  fs.mkdirSync(path.join(f.home, '.claude'));
  fs.writeFileSync(path.join(f.home, '.claude', 'nightly-rescue-state.json'), JSON.stringify({
    attempts: { [path.resolve(f.repo)]: { [dirtyStatus(f.repo).hash]: f.now } }, notifications: {}, failures: [],
  }));
  const result = await syncTree(f.repo, f.home, { ...f, now: f.now + 1000 });
  assert.ok(result.events.some(e => e.step === 'RESCUE_THROTTLED'));
  assert.equal(branches(f).length, 0);
});

test('state contention or corruption fails closed', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.claude'));
  const state = path.join(f.home, '.claude', 'nightly-rescue-state.json');
  fs.writeFileSync(`${state}.lock`, 'locked');
  assert.equal((await syncTree(f.repo, f.home, f)).clean, false);
  fs.unlinkSync(`${state}.lock`); fs.writeFileSync(state, 'broken');
  assert.equal((await syncTree(f.repo, f.home, f)).clean, false);
  assert.equal(branches(f).length, 0);
});

for (const staged of [false, true]) test(`snapshot handles deletions and renames: staged=${staged}`, async t => {
  const f = fixture(t);
  fs.renameSync(path.join(f.repo, 'tracked'), path.join(f.repo, 'renamed file'));
  if (staged) f.git('add', '-A');
  const before = f.git('status', '--porcelain');
  const result = await syncTree(f.repo, f.home, f);
  assert.ok(result.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(result));
  assert.equal(f.git('ls-tree', '--name-only', branches(f)[0]), 'renamed file\n');
  assert.equal(f.git('status', '--porcelain'), before);
});
