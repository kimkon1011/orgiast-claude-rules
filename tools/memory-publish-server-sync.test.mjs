import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncServerBeforeDeploy } from './memory-publish.mjs';
test('nightly deployment follows merged server main, refuses dirty worktree and fetch failures', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-sync-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.git'));
  const calls = []; let dirty = false, failFetch = false;
  const run = (_file, args) => { calls.push(args); return { status: failFetch && args[0] === 'fetch' ? 1 : 0,
    stdout: args[0] === 'branch' ? 'main' : args[0] === 'status' && dirty ? ' M api/memory.js' : '' }; };
  syncServerBeforeDeploy(dir, run); assert.deepEqual(calls.at(-1), ['merge', '--ff-only', 'origin/main']);
  dirty = true; calls.length = 0; assert.throws(() => syncServerBeforeDeploy(dir, run), /clean main/); assert.equal(calls.length, 2);
  dirty = false; failFetch = true; calls.length = 0; assert.throws(() => syncServerBeforeDeploy(dir, run), /同期/); assert.ok(!calls.some(c => c[0] === 'merge'));
});
