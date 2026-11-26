import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { processDirective } from './fleet-agent.mjs';
import { runChild } from './auto-session.mjs';
import { runSweep } from './quota-sweep.mjs';

const blocked = { blocked: true, reason: 'weekly-threshold', weeklyPercent: 99, fiveHourPercent: 1, resetsAt: '2026-11-25T01:00:00.000Z', source: 'simulate' };
function tempRepo() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-guard-integration-')); fs.mkdirSync(path.join(dir, '.git')); fs.mkdirSync(path.join(dir, '.claude'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude', 'fleet-agent-optin.json'), JSON.stringify({ accept: ['prompt'] })); return dir; }
function successfulChild(invocations) {
  return (exe, args) => {
    invocations.push({ exe, args });
    const child = new EventEmitter(); child.stdin = { end() {} }; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit('data', 'README'); child.emit('close', 0); });
    return child;
  };
}

test('fleet-agent は blocked 時に claude を解決せず codex-do を起動する', async () => {
  const home = tempRepo(); const invocations = []; const posted = [];
  const result = await processDirective({ id: 'guard-1', kind: 'prompt', body: 'read', cwd: home }, { home, repo: home, label: 'pc', hostname: 'pc', dryRun: false, post: async value => posted.push(value), spawnImpl: successfulChild(invocations), guardVerdict: blocked, resolveClaudeExe: async () => { throw new Error('claude must not resolve'); } });
  assert.equal(result.result.exitCode, 0);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].exe, process.execPath);
  assert.ok(invocations[0].args.some(value => String(value).endsWith('codex-do.mjs')));
  assert.match(posted[0], /codex-do へ回送/);
});

test('auto-session は blocked 時に spawn しない', async () => {
  let spawned = 0;
  const result = await runChild('claude.exe', 'x', process.cwd(), process.cwd(), 1000, { guardVerdict: blocked, spawnImpl: () => { spawned++; } });
  assert.equal(spawned, 0);
  assert.equal(result.skippedSeatGuard, true);
});

test('quota-sweep は Claude decision を blocked 時に正常見送りする', async () => {
  let spawned = 0; const logs = [];
  const result = await runSweep({ provider: 'claude', window: '7d', resetsAt: Date.now() + 1000, deadline: Date.now() + 1000, usedPercent: 99 }, { home: tempRepo(), state: {}, save() {}, windows: async () => [], active: async () => false, log: value => logs.push(value), env: {}, spawnImpl: () => { spawned++; }, guardVerdict: blocked });
  assert.equal(spawned, 0);
  assert.equal(result.skipped, true);
  assert.match(logs[0], /claude-seat-guard/);
});
