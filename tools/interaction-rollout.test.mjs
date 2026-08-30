import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRollout, runInteractionRollout } from './interaction-rollout.mjs';

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
