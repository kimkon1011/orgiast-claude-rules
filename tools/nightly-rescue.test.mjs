import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirtyStatus, rescueTree } from './nightly-rescue.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-rescue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'tracked'), 'original');
  git('add', '.'); git('commit', '-m', 'initial');
  git('init', '--bare', path.join(root, 'remote.git')); git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  const messages = [];
  const notify = async message => { messages.push(message); return { delivered: 'dm' }; };
  const now = new Date(2026, 9, 9, 12).getTime();
  return { root, repo, home, git, messages, notify, now };
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
  f.git('add', '.gitignore'); f.git('commit', '-m', 'ignore scratch');
  fs.mkdirSync(path.join(f.repo, 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'scratch', 'result'), 'precious');
  f.git('init', path.join(f.repo, 'nested clone'));
  fs.writeFileSync(path.join(f.repo, 'nested clone', 'file'), 'nested');
  f.git('worktree', 'add', '--detach', path.join(f.repo, 'linked clone'));
  assert.equal(dirtyStatus(f.repo).clean, true);
  assert.equal((await rescueTree(f.repo, f.home, f)).clean, true);
  assert.equal(branches(f).length, 0);
  fs.writeFileSync(path.join(f.repo, 'tracked'), 'real change');
  await rescueTree(f.repo, f.home, f);
  assert.equal(branches(f).length, 1);
  assert.equal(f.git('show', 'HEAD:tracked'), 'real change');
  assert.equal(f.git('ls-tree', '--name-only', 'HEAD'), '.gitignore\ntracked\n');
  assert.equal(f.messages.length, 1);
  f.git('clean', '-qfd', '-e', 'scratch/');
  assert.equal(fs.readFileSync(path.join(f.repo, 'scratch', 'result'), 'utf8'), 'precious');
  assert.ok(fs.existsSync(path.join(f.repo, 'nested clone', '.git')));
  assert.ok(fs.existsSync(path.join(f.repo, 'linked clone', '.git')));
});

test('successful rescues notify only once daily, with a fresh allowance next day', async t => {
  const f = fixture(t);
  for (const [i, offset] of [0, 120000, 86400000].entries()) {
    fs.writeFileSync(path.join(f.repo, `new-${i}`), 'change');
    await rescueTree(f.repo, f.home, { ...f, now: f.now + offset });
  }
  assert.equal(branches(f).length, 3);
  assert.equal(f.messages.length, 2);
});

test('three failures in an hour send one loop notification, not a rescue notification', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(path.join(f.repo, `change-${i}`), 'change');
    await rescueTree(f.repo, f.home, { ...f, now: f.now + i * 120000 });
  }
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /RESCUE_FAILED/);
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
  f.git('add', '-A');
  fs.writeFileSync(path.join(f.repo, '[literal]'), 'keep');
  const result = await rescueTree(f.repo, f.home, f);
  assert.ok(result.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(result.events));
  assert.equal(f.git('show', 'HEAD:renamed file'), 'original');
  assert.equal(f.git('show', 'HEAD:[literal]'), 'keep');
  assert.equal(f.git('ls-tree', '--name-only', 'HEAD').includes('tracked'), false);
});

for (const staged of [false, true]) test(`rescues a deletion: staged=${staged}`, async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.repo, 'tracked'));
  if (staged) f.git('add', '-A');
  const result = await rescueTree(f.repo, f.home, f);
  assert.ok(result.events.some(e => e.step === 'RESCUE_LOCAL_OK'), JSON.stringify(result.events));
  assert.equal(f.git('ls-tree', '--name-only', 'HEAD'), '');
});
