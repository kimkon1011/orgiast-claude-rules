import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLock, releaseLock, _singleInstance } from './single-instance.mjs';

test('acquire, reject live owner, release', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'single-instance-home-'));
  process.env.ORGIAST_LOCK_HOME = home;
  const name = `single-instance-test-${process.pid}`;
  assert.deepEqual(acquireLock(name), { acquired: true });
  assert.deepEqual(acquireLock(name), { acquired: false, ownerPid: process.pid });
  const file = path.join(home, '.claude', 'locks', `${name}.lock`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  assert.equal(releaseLock(name), true);
  assert.equal(fs.existsSync(file), false);
  delete process.env.ORGIAST_LOCK_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

test('six-hour-old owner is stale even when pid is alive', () => {
  assert.equal(_singleInstance.ownerIsCurrent({ pid: process.pid, startedAt: new Date(Date.now() - _singleInstance.MAX_AGE_MS - 1).toISOString() }), false);
});
