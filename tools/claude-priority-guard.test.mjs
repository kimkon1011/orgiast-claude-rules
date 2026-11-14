import test from 'node:test';
import assert from 'node:assert/strict';
import { guardClaudePriority } from './claude-priority-guard.mjs';

const SPAWN_RESULT_PREFIX = (raw) => ({ stdout: raw ? raw.replace(/^﻿/, '').trim() : '' });

test('non-Windows returns skipped', () => {
  const result = guardClaudePriority({ platform: 'linux', exec() { assert.fail(); } });
  assert.deepEqual(result, { skipped: 'non-win32' });
});

test('Normal processes are lowered', () => {
  const simulated = JSON.stringify({ lowered: 3, alreadyLow: 0, excluded: 0, failed: 0 });
  const exec = (cmd, args, opts) => SPAWN_RESULT_PREFIX(simulated);
  const result = guardClaudePriority({ platform: 'win32', exec });
  assert.deepEqual(result, { lowered: 3, alreadyLow: 0, excluded: 0, failed: 0 });
});

test('WindowsApps processes are excluded', () => {
  const simulated = JSON.stringify({ lowered: 0, alreadyLow: 0, excluded: 2, failed: 0 });
  const exec = (cmd, args, opts) => SPAWN_RESULT_PREFIX(simulated);
  const result = guardClaudePriority({ platform: 'win32', exec });
  assert.equal(result.excluded, 2);
  assert.equal(result.lowered, 0);
});

test('BelowNormal processes are not touched', () => {
  const simulated = JSON.stringify({ lowered: 0, alreadyLow: 5, excluded: 0, failed: 0 });
  const exec = (cmd, args, opts) => SPAWN_RESULT_PREFIX(simulated);
  const result = guardClaudePriority({ platform: 'win32', exec });
  assert.equal(result.alreadyLow, 5);
  assert.equal(result.lowered, 0);
});

test('failed processes do not abort', () => {
  const simulated = JSON.stringify({ lowered: 2, alreadyLow: 0, excluded: 0, failed: 1 });
  const exec = (cmd, args, opts) => SPAWN_RESULT_PREFIX(simulated);
  const result = guardClaudePriority({ platform: 'win32', exec });
  assert.equal(result.failed, 1);
  assert.equal(result.lowered, 2);
  assert.equal(result.alreadyLow, 0);
});

test('powershell is called with correct args', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return SPAWN_RESULT_PREFIX(JSON.stringify({ lowered: 0, alreadyLow: 0, excluded: 0, failed: 0 }));
  };
  guardClaudePriority({ platform: 'win32', exec });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.ok(calls[0].args.includes('-Command'));
  assert.ok(calls[0].opts.windowsHide);
  assert.ok(calls[0].opts.timeout <= 15000);
});

test('malformed PowerShell output returns parse error', () => {
  const exec = (cmd, args, opts) => SPAWN_RESULT_PREFIX('{broken');
  assert.throws(() => guardClaudePriority({ platform: 'win32', exec }));
});

test('exit 0 regardless of outcome via real direct run of the module', async (t) => {
  // Spawn the actual script to confirm it runs without crashing and outputs JSON.
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['tools/claude-priority-guard.mjs'],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout.replace(/^﻿/, '').trim());
  // On real Windows, may have lowered/alreadyLow/excluded/failed or skipped if non-win32
  assert.ok(parsed.skipped === 'non-win32' || typeof parsed.lowered === 'number');
  assert.ok(typeof parsed.alreadyLow === 'number' || parsed.skipped === 'non-win32');
  assert.ok(typeof parsed.excluded === 'number' || parsed.skipped === 'non-win32');
  assert.ok(typeof parsed.failed === 'number' || parsed.skipped === 'non-win32');
});