import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decideAction, runSelfheal, sha256 } from './hook-tree-selfheal.mjs';

test('working === main は uptodate', () => {
  assert.equal(decideAction({ working: 'same', head: 'old', main: 'same', lastWrittenSha: null }).action, 'uptodate');
});

test('clean で main が違えば updated', () => {
  assert.equal(decideAction({ working: 'old', head: 'old', main: 'new', lastWrittenSha: null }).action, 'updated');
});

test('前回 selfheal の SHA と一致すれば updated', () => {
  assert.equal(decideAction({ working: 'written', head: 'old', main: 'new', lastWrittenSha: sha256('written') }).action, 'updated');
});

test('dirty で前回 SHA と不一致なら skipped', () => {
  assert.equal(decideAction({ working: 'mine', head: 'old', main: 'new', lastWrittenSha: sha256('other') }).action, 'skipped');
});

test('origin/main に無ければ skipped', () => {
  assert.equal(decideAction({ working: 'mine', head: 'mine', main: null, lastWrittenSha: null }).action, 'skipped');
});

test('未追跡の新規作業は skipped', () => {
  assert.equal(decideAction({ working: 'mine', head: null, main: 'upstream', lastWrittenSha: null }).action, 'skipped');
});

test('selfheal が書いた内容は2回目もさらに新しい main へ updated', () => {
  const first = decideAction({ working: 'v1', head: 'v1', main: 'v2', lastWrittenSha: null });
  assert.equal(first.action, 'updated');
  const second = decideAction({ working: 'v2', head: 'v1', main: 'v3', lastWrittenSha: sha256('v2') });
  assert.equal(second.action, 'updated');
});

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-selfheal-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  git(root, ['init', '--bare', origin]);
  git(root, ['init', '-b', 'main', seed]);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(seed, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'tools', 'sample.mjs'), 'export const value = "old";\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'old']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['clone', origin, repo]);
  git(repo, ['checkout', 'main']);
  fs.writeFileSync(path.join(seed, 'tools', 'sample.mjs'), 'export const value = "new";\n');
  git(seed, ['commit', '-am', 'new']);
  git(seed, ['push']);
  git(repo, ['fetch', 'origin']);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Notification: [{ hooks: [{ command: `node "${repo}/orgiast-claude-rules/tools/sample.mjs"` }] }] } }));
  return { root, repo, home, ledger: path.join(home, '.claude', 'hook-selfheal-ledger.jsonl') };
}

test('統合: clean な旧版を origin/main へ更新し updated を記録する', () => {
  const f = fixture();
  try {
    runSelfheal({ repo: f.repo, home: f.home, fetch: false });
    assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'sample.mjs'), 'utf8'), 'export const value = "new";\n');
    const records = fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, 'updated');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('統合: dirty な作業ファイルを変えず skipped を記録する', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'tools', 'sample.mjs'), 'export const value = "mine";\n');
    runSelfheal({ repo: f.repo, home: f.home, fetch: false });
    assert.equal(fs.readFileSync(path.join(f.repo, 'tools', 'sample.mjs'), 'utf8'), 'export const value = "mine";\n');
    const records = fs.readFileSync(f.ledger, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1);
    assert.equal(records[0].action, 'skipped');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
