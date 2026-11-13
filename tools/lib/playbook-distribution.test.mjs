import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { distributePlaybooks } from './playbook-distribution.mjs';

const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

function fixture(t) {
  const repo = temp('playbook-distribution-repo-'), home = temp('playbook-distribution-home-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  const source = path.join(repo, 'playbooks', 'A.md');
  write(source, 'v1\n');
  git(repo, ['add', 'playbooks/A.md']);
  git(repo, ['commit', '-m', 'v1']);
  write(source, 'v2\n');
  git(repo, ['commit', '-am', 'v2']);
  return { repo, home, source, target: path.join(home, '.claude', 'playbooks', 'A.md') };
}

test('過去にコミットされた未編集版は最新版へ更新する', t => {
  const { repo, home, target } = fixture(t);
  write(target, 'v1\r\n');
  assert.equal(distributePlaybooks(repo, home), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'v2\n');
});

test('過去版にPC側の追記がある場合は保持する', t => {
  const { repo, home, target } = fixture(t);
  write(target, 'v1\nPCで追記\n');
  assert.equal(distributePlaybooks(repo, home), 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'v1\nPCで追記\n');
});

test('未配布のplaybookはコピーする', t => {
  const { repo, home, target } = fixture(t);
  assert.equal(distributePlaybooks(repo, home), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'v2\n');
});
