import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convergeLockPath, acquireConvergeLock } from './setup.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('acquireConvergeLock: ロックを取得できる', t => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const cleanup = acquireConvergeLock(home, { exitImpl: () => { throw new Error('should not exit'); } });
  assert.ok(typeof cleanup === 'function', 'cleanup function should be returned');
  const lockFile = convergeLockPath(home);
  assert.ok(fs.existsSync(lockFile), 'lock file should exist');
  const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(content.pid, process.pid);
  assert.ok(typeof content.startedAt === 'string');
  cleanup();
  assert.equal(fs.existsSync(lockFile), false, 'lock file should be removed after cleanup');
});

test('acquireConvergeLock: 生存ロックがあるとスキップ（exit 0）', t => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const lockFile = convergeLockPath(home);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // 生存中の pid（自分自身）でロックを作成
  const lockData = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  fs.writeFileSync(lockFile, lockData, 'utf8');

  let exitCode = null;
  let logMessage = null;
  acquireConvergeLock(home, {
    exitImpl: (code) => { exitCode = code; throw new Error('exit'); },
    logImpl: (msg) => { logMessage = msg; },
  });
  assert.equal(exitCode, 0);
  assert.ok(logMessage.includes('別プロセス'));
});

test('acquireConvergeLock: 死亡 pid のロックは奪取できる', t => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const lockFile = convergeLockPath(home);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // 存在しない pid（999999999）でロックを作成
  const lockData = JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() });
  fs.writeFileSync(lockFile, lockData, 'utf8');

  const cleanup = acquireConvergeLock(home, { exitImpl: () => { throw new Error('should not exit'); } });
  assert.ok(fs.existsSync(lockFile), 'lock file should be recreated');
  const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(content.pid, process.pid);
  cleanup();
});

test('acquireConvergeLock: 15分超過のロックは奪取できる', t => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const lockFile = convergeLockPath(home);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // 16分前のロック
  const oldTime = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  const lockData = JSON.stringify({ pid: process.pid, startedAt: oldTime });
  fs.writeFileSync(lockFile, lockData, 'utf8');

  const cleanup = acquireConvergeLock(home, { exitImpl: () => { throw new Error('should not exit'); } });
  assert.ok(fs.existsSync(lockFile), 'lock file should be recreated');
  const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(content.pid, process.pid);
  // startedAt が更新されている
  assert.ok(Date.parse(content.startedAt) > Date.parse(oldTime));
  cleanup();
});

test('acquireConvergeLock: 15分以内の生存ロックはスキップ（now 注入でテスト）', t => {
  const root = fixture(t);
  const home = path.join(root, 'home');
  const lockFile = convergeLockPath(home);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  // 5分前のロック（自分自身の pid）
  const fixedNow = Date.parse('2026-11-12T12:00:00.000Z');
  const startedAt = new Date(fixedNow - 5 * 60 * 1000).toISOString();
  const lockData = JSON.stringify({ pid: process.pid, startedAt });
  fs.writeFileSync(lockFile, lockData, 'utf8');

  let exitCode = null;
  let logMessage = null;
  acquireConvergeLock(home, {
    exitImpl: (code) => { exitCode = code; throw new Error('exit'); },
    logImpl: (msg) => { logMessage = msg; },
    now: () => fixedNow,
  });
  assert.equal(exitCode, 0);
  assert.ok(logMessage.includes('別プロセス'));
});
