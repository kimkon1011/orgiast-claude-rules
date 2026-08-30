import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapRequiredHooks, runAfterBootstrap } from './claude-cost-reporter.mjs';
import { REQUIRED_HOOKS } from './hook-selfcheck.mjs';

function fixture(settings = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-reporter-bootstrap-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  return home;
}

function completeSettings() {
  const hooks = {};
  for (const [event, script] of REQUIRED_HOOKS) {
    (hooks[event] ||= []).push({ hooks: [{ command: `node C:/repo/tools/${script}` }] });
  }
  return { hooks };
}

test('必須hook欠落時はregister-hooksを起動する', () => {
  const home = fixture();
  const calls = [];
  const logs = [];
  const result = bootstrapRequiredHooks({ home, repo: 'C:/repo', now: 1_000, spawn: (...args) => { calls.push(args); return { status: 0 }; }, log: (line) => logs.push(line) });
  assert.equal(result.repaired, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(-1), ['--hooks-only']);
  assert.equal(calls[0][2].timeout, 30_000);
  assert.equal(calls[0][2].env.ORGIAST_HOME, home);
  assert.equal(calls[0][2].env.ORGIAST_REPO, 'C:/repo');
  assert.equal(logs.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('必須hookが揃っていれば起動も出力もしない', () => {
  const home = fixture(completeSettings());
  let spawned = false;
  const logs = [];
  bootstrapRequiredHooks({ home, now: 1_000, spawn: () => { spawned = true; }, log: (line) => logs.push(line) });
  assert.equal(spawned, false);
  assert.deepEqual(logs, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('同じ日の2回目は日次ガードで起動しない', () => {
  const home = fixture();
  let calls = 0;
  const options = { home, now: 1_000, spawn: () => { calls += 1; return { status: 0 }; }, log: () => {} };
  bootstrapRequiredHooks(options);
  bootstrapRequiredHooks(options);
  assert.equal(calls, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('ブートストラップ例外を呼び出し側で隔離して本来の集計を続行できる', () => {
  const report = { mtdUsd: 12.34 };
  const result = runAfterBootstrap({
    bootstrap: () => { throw new Error('spawn failure'); },
    collect: () => report,
  });
  assert.equal(result, report);
});
