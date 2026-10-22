import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bootstrapUser, registrationRepo } from './session-bootstrap.mjs';

const home = path.resolve('/home/u');
const nightly = path.join(home, '.claude', 'nightly-repo');
const worktree = path.resolve('/work/orgiast-rules-wt/feature');
const hasRegister = (...dirs) => (file) => dirs.some((dir) => file === path.join(dir, 'tools', 'register-hooks.mjs'));

test('同期 checkout がある機体では worktree を ORGIAST_REPO に固定しない', () => {
  assert.equal(registrationRepo({ home, repo: worktree, exists: hasRegister(nightly) }), null);
});

test('anchor 自身から起動したときはその checkout を登録する', () => {
  assert.equal(registrationRepo({ home, repo: nightly, exists: hasRegister(nightly) }), nightly);
});

test('anchor がまだ無い新規ユーザーは従来どおり自分の checkout を登録する', () => {
  assert.equal(registrationRepo({ home, repo: worktree, exists: () => false }), worktree);
});

test('bootstrapUser は worktree からの起動で ORGIAST_REPO を子に渡さない', () => {
  const calls = [];
  const run = (cmd, args, opts) => { calls.push(opts.env); return { status: 0 }; };
  const saved = process.env.ORGIAST_REPO;
  process.env.ORGIAST_REPO = worktree;
  try {
    const result = bootstrapUser({ home, repo: worktree, platform: 'win32', run, exists: hasRegister(nightly) });
    assert.equal(result.pinnedRepo, null);
    assert.equal(calls.length, 2);
    for (const env of calls) {
      assert.equal('ORGIAST_REPO' in env, false);
      assert.equal(env.ORGIAST_HOME, home);
    }
  } finally {
    if (saved === undefined) delete process.env.ORGIAST_REPO; else process.env.ORGIAST_REPO = saved;
  }
});
