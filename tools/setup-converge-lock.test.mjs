import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireSetupConvergeLock } from './lib/setup-converge-lock.mjs';

test('(a) 取得: ロックが存在しない場合、正常に取得・作成できる', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-lock-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const lock = acquireSetupConvergeLock({ home, pid: 1234, now: () => 10000 });
  assert.equal(lock.acquired, true);
  assert.ok(fs.existsSync(lock.lockFile));
  const data = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
  assert.equal(data.pid, 1234);
  assert.equal(data.startedAt, 10000);
  lock.release();
  assert.equal(fs.existsSync(lock.lockFile), false);
});

test('(b) 生存ロックでスキップ: 15分以内の生存プロセスロックが存在する場合取得をスキップ', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-lock-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const lock1 = acquireSetupConvergeLock({ home, pid: 1111, now: () => 10000, isPidAlive: () => true });
  assert.equal(lock1.acquired, true);

  const lock2 = acquireSetupConvergeLock({ home, pid: 2222, now: () => 20000, isPidAlive: () => true });
  assert.equal(lock2.acquired, false);
  assert.match(lock2.reason, /setup --converge は別プロセス\(pid=1111\)で実行中のためスキップ/);
  assert.ok(fs.existsSync(lock1.lockFile));
});

test('(c) 死亡 pid のロック奪取: 死亡プロセスのロックが存在する場合奪取できる', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-lock-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const lock1 = acquireSetupConvergeLock({ home, pid: 9999, now: () => 10000, isPidAlive: () => false });
  assert.equal(lock1.acquired, true);

  const lock2 = acquireSetupConvergeLock({ home, pid: 2222, now: () => 20000, isPidAlive: p => p === 2222 });
  assert.equal(lock2.acquired, true);
  const data = JSON.parse(fs.readFileSync(lock2.lockFile, 'utf8'));
  assert.equal(data.pid, 2222);
});

test('(d) 15分超過の奪取: 15分以上前のロックが存在する場合生存プロセスであっても奪取できる', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-lock-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const now1 = 100000;
  const lock1 = acquireSetupConvergeLock({ home, pid: 1111, now: () => now1, isPidAlive: () => true });
  assert.equal(lock1.acquired, true);

  const now2 = now1 + 16 * 60 * 1000;
  const lock2 = acquireSetupConvergeLock({ home, pid: 3333, now: () => now2, isPidAlive: () => true });
  assert.equal(lock2.acquired, true);
  const data = JSON.parse(fs.readFileSync(lock2.lockFile, 'utf8'));
  assert.equal(data.pid, 3333);
});
