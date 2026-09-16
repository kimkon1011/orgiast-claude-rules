import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapRequiredHooks, cacheRefreshArgs, postDecision, runAfterBootstrap } from './claude-cost-reporter.mjs';
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

test('6時間ガード中のキャッシュ更新は投稿せず集計を続ける', () => {
  assert.equal(postDecision({ withinGuard: true, refreshCache: true }), 'cache-only');
});

test('6時間ガード中の通常実行は従来どおりスキップする', () => {
  assert.equal(postDecision({ withinGuard: true, refreshCache: false }), 'skip');
});

test('dry-runとforceは6時間ガードを無視して投稿経路へ進む', () => {
  assert.equal(postDecision({ withinGuard: true, dryRun: true }), 'post');
  assert.equal(postDecision({ withinGuard: true, force: true }), 'post');
});

test('6時間ガード明けのキャッシュ更新は投稿する', () => {
  assert.equal(postDecision({ withinGuard: false, refreshCache: true }), 'post');
});

test('裏方キャッシュ更新の引数にforceを付けない', () => {
  const reporterFile = fileURLToPath(new URL('./claude-cost-reporter.mjs', import.meta.url));
  assert.deepEqual(cacheRefreshArgs(), [reporterFile, '--refresh-cache']);
  assert.equal(cacheRefreshArgs().includes('--force'), false);
});

test('ソースにforce付きキャッシュ更新の引数列を残さない', () => {
  const reporterFile = fileURLToPath(new URL('./claude-cost-reporter.mjs', import.meta.url));
  const source = fs.readFileSync(reporterFile, 'utf8');
  assert.equal(source.includes("'--force', '--refresh-cache'"), false);
});
