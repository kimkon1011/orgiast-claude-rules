import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReclaimDirectory, RECLAIM_STALE_MS } from './reclaim-lock.mjs';

for (const competing of [false, true]) {
  test(`stale reclaim removed concurrently; competitor=${competing}`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-race-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, 'lock.reclaim'), now = Date.now();
    fs.mkdirSync(dir);
    const old = new Date(now - RECLAIM_STALE_MS - 1000);
    fs.utimesSync(dir, old, old);
    const remove = fs.rmdirSync;
    t.mock.method(fs, 'rmdirSync', target => {
      remove(target);
      if (competing) fs.mkdirSync(target);
      throw Object.assign(new Error('removed concurrently'), { code: 'ENOENT' });
    });
    if (competing) assert.throws(() => createReclaimDirectory(dir, { now: () => now }), { code: 'EEXIST' });
    else createReclaimDirectory(dir, { now: () => now });
    assert.equal(fs.statSync(dir).isDirectory(), true);
    t.mock.restoreAll();
  });
}

test('stale nonempty reclaim is not removed recursively', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-nonempty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'lock.reclaim'), now = Date.now();
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'keep'), 'keep');
  const old = new Date(now - RECLAIM_STALE_MS - 1000);
  fs.utimesSync(dir, old, old);
  assert.throws(() => createReclaimDirectory(dir, { now: () => now }), { code: 'ENOTEMPTY' });
  assert.equal(fs.readFileSync(path.join(dir, 'keep'), 'utf8'), 'keep');
});

test('missing reclaim during stat retries mkdir without removing a new competitor', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-stat-race-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'lock.reclaim');
  fs.mkdirSync(dir);
  t.mock.method(fs, 'statSync', () => {
    fs.rmdirSync(dir); fs.mkdirSync(dir);
    throw Object.assign(new Error('removed before stat'), { code: 'ENOENT' });
  });
  assert.throws(() => createReclaimDirectory(dir), { code: 'EEXIST' });
  t.mock.restoreAll();
  assert.equal(fs.statSync(dir).isDirectory(), true);
});
