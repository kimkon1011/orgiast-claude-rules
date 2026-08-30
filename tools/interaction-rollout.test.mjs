import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRollout, buildWatchMessage, runInteractionRollout, shouldNotify, shouldRunWatch } from './interaction-rollout.mjs';

test('適用済・未適用/旧版・未報告の3群に分類する', () => {
  const rows = [
    { pcName: 'a', reportedAt: '2026-08-30 10:00', interactionLoop: '適用済(ab12345) / 最終実行 2026-08-30 03:00' },
    { pcName: 'b', reportedAt: '2026-08-30 09:00', interactionLoop: '旧版(old / main=new)' },
    { pcName: 'c', reportedAt: '2026-08-30 08:00', interactionLoop: '未適用' },
    { pcName: 'd', reportedAt: '2026-08-30 07:00', interactionLoop: '' },
  ];
  const result = buildRollout(rows);
  assert.deepEqual(result.summary, { applied: 1, outdated: 2, unreported: 1 });
  assert.deepEqual(result.rows.map((row) => row.category), ['applied', 'outdated', 'outdated', 'unreported']);
});

test('reportedAt が空なら適用欄に値があっても未報告', () => {
  const result = buildRollout([{ pcName: 'silent', reportedAt: '', interactionLoop: '適用済(ab12345)' }]);
  assert.equal(result.rows[0].category, 'unreported');
});

test('最終報告の新しい順に並べる', () => {
  const result = buildRollout([
    { pcName: 'old', reportedAt: '2026-08-29 12:00', interactionLoop: '未適用' },
    { pcName: 'new', reportedAt: '2026-08-30 12:00', interactionLoop: '適用済(x)' },
    { pcName: 'empty', reportedAt: '', interactionLoop: '' },
  ]);
  assert.deepEqual(result.rows.map((row) => row.pcName), ['new', 'old', 'empty']);
});

test('doGet が ok:false でも例外終了せず stderr に出して exit 0 相当', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_SHEET_URL=https://example.invalid/fleet\nFLEET_SHEET_TOKEN=test\n');
  const output = { stdout: [], stderr: [] };
  await runInteractionRollout({
    env: { ORGIAST_HOME: home },
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, error: 'unauthorized' }) }),
    stdout: (line) => output.stdout.push(line),
    stderr: (line) => output.stderr.push(line),
  });
  assert.deepEqual(output.stdout, []);
  assert.equal(output.stderr.length, 1);
  assert.match(output.stderr[0], /doGetエラー: unauthorized/);
});

test('前回と同じ集計なら通知しない', () => {
  const counts = { applied: 3, stale: 2, unreported: 1, done: false };
  assert.equal(shouldNotify(counts, counts), false);
});

test('applied が増えたら通知する', () => {
  assert.equal(shouldNotify(
    { applied: 2, stale: 2, unreported: 1, done: false },
    { applied: 3, stale: 2, unreported: 1, done: false },
  ), true);
});

test('stale/unreported が 0 なら完了メッセージ', () => {
  assert.equal(buildWatchMessage({ applied: 7, stale: 0, unreported: 0, done: true }, []), '✅ 対話ループ: 全7台が適用済');
});

test('done: true の後は変化があっても通知しない', () => {
  assert.equal(shouldNotify(
    { applied: 7, stale: 0, unreported: 0, done: true },
    { applied: 6, stale: 1, unreported: 0, done: false },
  ), false);
});

test('未適用・旧版の列挙は10台まで', () => {
  const names = Array.from({ length: 11 }, (_, index) => `pc-${index + 1}`);
  const message = buildWatchMessage({ applied: 1, stale: 11, unreported: 2, done: false }, names);
  assert.match(message, /pc-10/);
  assert.doesNotMatch(message, /pc-11/);
});

test('マーカーファイルが無ければ watch は実行対象外', () => {
  assert.equal(shouldRunWatch(false), false);
  assert.equal(shouldRunWatch(true), true);
});

test('--watch はマーカー無しなら設定未存在でも完全無音', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'interaction-rollout-no-marker-'));
  const output = { stdout: [], stderr: [] };
  await runInteractionRollout({
    argv: ['--watch'], env: { ORGIAST_HOME: home },
    stdout: (line) => output.stdout.push(line), stderr: (line) => output.stderr.push(line),
    fetchImpl: async () => { throw new Error('呼ばれてはいけない'); },
  });
  assert.deepEqual(output, { stdout: [], stderr: [] });
});
