import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLock } from './discord-dm-drafts.mjs';

test('生存中かつ14分以内のlockは奪わない', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'lock'), now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ pid: 42, createdAt: new Date(now - 1000).toISOString() }));
  assert.equal(acquireLock(file, { now, isAlive: () => true }), null);
});

test('死亡PIDまたは14分超のlockを回収しfinally相当で解放', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, age, alive] of [['dead', 1000, false], ['old', 15 * 60000, true]]) {
    const file = path.join(dir, name), now = Date.now();
    fs.writeFileSync(file, JSON.stringify({ pid: 42, createdAt: new Date(now - age).toISOString() }));
    const release = acquireLock(file, { now, isAlive: () => alive });
    assert.equal(typeof release, 'function');
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(owner.pid, process.pid);
    release(); assert.equal(fs.existsSync(file), false);
  }
});
