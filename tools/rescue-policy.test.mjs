import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirtyStatus, WORK_DIRECTORY_EXCLUDES } from './rescue-policy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original');
  git(['add', 'tracked.txt']);
  git(['commit', '-m', 'initial']);
  return { root, git };
}

// stall-sweeper は停滯調査の受け取り票をワークツリー直下の .stall-sweeper/ に書く。
// これが rescue 対象に残ると、中身の無い「rescue 枝のレビュー」TODO が毎晩積み上がる。
test('.stall-sweeper/ だけが dirty なツリーは rescue 対象にしない', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, '.stall-sweeper'));
  fs.writeFileSync(path.join(root, '.stall-sweeper', 'abc.investigation.md'), '# receipt\n');
  fs.writeFileSync(path.join(root, '.stall-sweeper', 'abc.result.json'), '{}\n');
  const status = dirtyStatus(root);
  assert.equal(status.clean, true, JSON.stringify(status));
  assert.deepEqual(status.paths, []);
  assert.deepEqual(status.snapshotPaths, []);
});

test('.stall-sweeper/ は他の作業ディレクトリ除外と並んで登録されている', () => {
  assert.ok(WORK_DIRECTORY_EXCLUDES.includes('.stall-sweeper/'));
  assert.ok(WORK_DIRECTORY_EXCLUDES.includes('scratch/'));
});

test('除外ディレクトリ以外の未追跡ファイルは今まで通り rescue 対象になる', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, '.stall-sweeper'));
  fs.writeFileSync(path.join(root, '.stall-sweeper', 'abc.result.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'precious.txt'), 'keep me\n');
  const status = dirtyStatus(root);
  assert.equal(status.clean, false);
  assert.deepEqual(status.paths, ['precious.txt']);
});

test('scratch/ と .work-*/ の除外は維持されている', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'scratch'));
  fs.mkdirSync(path.join(root, '.work-123'));
  fs.writeFileSync(path.join(root, 'scratch', 'clone.txt'), 'x\n');
  fs.writeFileSync(path.join(root, '.work-123', 'note.txt'), 'x\n');
  assert.equal(dirtyStatus(root).clean, true);
});

// 除外リストだけでは git の追跡（破壊的ステップ後の巻き戻し）を防げないため、
// リポジトリの .gitignore 側でも機械ローカル扱いになっていることを固定する。
test('リポジトリの .gitignore が .stall-sweeper/ を無視する', () => {
  const dir = path.join(repoRoot, '.stall-sweeper');
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, 'rescue-policy-test-probe.txt');
  fs.writeFileSync(probe, 'probe\n');
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'check-ignore', '-v', '.stall-sweeper/rescue-policy-test-probe.txt'], { encoding: 'utf8' });
    assert.match(out, /\.stall-sweeper\//);
  } finally {
    fs.rmSync(probe, { force: true });
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
});
