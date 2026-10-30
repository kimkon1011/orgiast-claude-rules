import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomic, read, json, acquireLock,
  pointerFile, accessDenied,
  readWorktreePointer, writeWorktreePointer,
} from '../../tools/quota-sweep.mjs';

const temp = t => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sweep-io-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
};

// ── atomic file write ──────────────────────────────────────────────────

test('atomic writes JSON content to file', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.json');
  atomic(file, { key: 'value', num: 42 });
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('"key": "value"'));
  assert.ok(content.includes('"num": 42'));
  assert.ok(content.endsWith('\n'));
});

// ── read / json helpers ────────────────────────────────────────────────

test('read returns content of existing file', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.txt');
  fs.writeFileSync(file, 'hello\nworld\n');
  assert.equal(read(file), 'hello\nworld\n');
});

test('read returns empty string for missing file', () => {
  assert.equal(read('/nonexistent/path.txt'), '');
});

test('read throws for non-ENOENT errors', t => {
  const dir = temp(t);
  const file = path.join(dir, 'sub');
  fs.mkdirSync(file);
  assert.throws(() => read(file));
});

test('json returns parsed content or fallback', t => {
  const dir = temp(t);
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{"a":1}');
  assert.deepEqual(json(file), { a: 1 });
  assert.deepEqual(json(path.join(dir, 'missing.json')), {});
  assert.deepEqual(json(path.join(dir, 'missing.json'), { default: true }), { default: true });
});

// ── acquireLock with real filesystem ───────────────────────────────────

test('acquireLock creates lock file and returns release function', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.lock');
  const release = acquireLock(file);
  assert.equal(typeof release, 'function');
  assert.ok(fs.existsSync(file));
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.ok(content.startedAt);
  release();
  assert.equal(fs.existsSync(file), false);
});

test('acquireLock returns null when lock is held by live process', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.lock');
  const release = acquireLock(file);
  assert.equal(acquireLock(file, { alive: () => true }), null);
  release();
});

test('acquireLock reclaims lock from dead process', t => {
  const dir = temp(t);
  const file = path.join(dir, 'test.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: 99999, startedAt: 'old' }));
  const release = acquireLock(file, { alive: () => false });
  assert.equal(typeof release, 'function');
  assert.ok(fs.existsSync(file));
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(content.pid, process.pid, 'should contain new PID after reclaim');
  release();
});

// ── pointerFile and accessDenied ───────────────────────────────────────

test('pointerFile returns .git path', () => {
  assert.equal(pointerFile('/my/repo'), path.join('/my/repo', '.git'));
  assert.equal(pointerFile('C:\\repo'), path.join('C:\\repo', '.git'));
  assert.equal(pointerFile('/my/repo').endsWith('.git'), true);
});

test('accessDenied detects EPERM and EACCES', () => {
  assert.ok(accessDenied(Object.assign(new Error('perm'), { code: 'EPERM' })));
  assert.ok(accessDenied(Object.assign(new Error('acc'), { code: 'EACCES' })));
  assert.equal(accessDenied(Object.assign(new Error('enoent'), { code: 'ENOENT' })), false);
  assert.equal(!!accessDenied(null), false);
  assert.equal(!!accessDenied(undefined), false);
});

// ── readWorktreePointer / writeWorktreePointer ─────────────────────────

test('readWorktreePointer reads gitdir pointer from file', t => {
  const dir = temp(t);
  const file = path.join(dir, '.git');
  fs.writeFileSync(file, 'gitdir: ../nightly-repo/.git/worktrees/sweep\n');
  assert.equal(readWorktreePointer(file), '../nightly-repo/.git/worktrees/sweep');
});

test('readWorktreePointer returns null for non-matching content', t => {
  const dir = temp(t);
  const file = path.join(dir, '.git');
  fs.writeFileSync(file, 'not a gitdir pointer\n');
  assert.equal(readWorktreePointer(file), null);
});

test('readWorktreePointer throws for non-EPERM errors', t => {
  if (process.platform === 'win32') return;
  const dir = temp(t);
  const file = path.join(dir, '.git');
  fs.writeFileSync(file, 'gitdir: x\n');
  try { fs.chmodSync(file, 0o000); } catch { return; }
  assert.throws(() => readWorktreePointer(file));
});

test('writeWorktreePointer writes gitdir pointer', t => {
  const dir = temp(t);
  const file = path.join(dir, '.git');
  writeWorktreePointer(file, 'gitdir: ../relative\n');
  assert.ok(fs.readFileSync(file, 'utf8').includes('gitdir: ../relative'));
});