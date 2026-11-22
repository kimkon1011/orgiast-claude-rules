import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCursorUsagePace } from './cursor-usage-pace.mjs';
import { cursorUsagePaceTxtPath, ownerReportPath, cursorUsagePaceStatePath } from './lib/cursor-usage-pace.mjs';

test('CLI は引数の％で1行を書き、遅れなら fill する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-cli-'));
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const result = await runCursorUsagePace({
    home,
    now,
    args: ['--cursor-models', '5', '--other-models', '1', '--source', 'owner-report'],
  });
  assert.equal(result.decision, 'behind');
  assert.equal(result.fill, true);
  assert.equal(fs.readFileSync(cursorUsagePaceTxtPath(home), 'utf8').trim(), result.line);
  assert.match(result.line, /取得:owner-report/);
});

test('公式APIが取れないときは％なしで unknown と書き、引数が無いと推測しない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-cli-missing-'));
  const now = Date.parse('2026-11-21T23:17:00+09:00');
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.decision, 'unknown');
  assert.equal(result.fill, false);
  assert.match(result.line, /Cursor Models —%/);
  assert.match(fs.readFileSync(cursorUsagePaceTxtPath(home), 'utf8'), /判定:未取得/);
});

test('API不可時に owner-report があれば前回値で推定する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-owner-'));
  const dir = path.join(home, '.claude', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerReportPath(home), JSON.stringify({
    cursorModelsPct: 5, otherModelsPct: 1, onDemandUsed: false, at: '2026-11-21T23:17:00+09:00', by: 'kim',
  }));
  const now = Date.parse('2026-11-22T19:30:00+09:00'); // ~20h later
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.decision, 'behind');
  assert.equal(result.fill, true);
  assert.match(result.line, /Cursor Models 5\.0%/);
  assert.match(result.line, /Other Models 1\.0%/);
  assert.match(result.line, /取得:前回値\(owner-report/);
  assert.match(result.line, /\(推定\)/);
  assert.match(result.line, /判定:遅れ/);
});

test('API不可時に carry-forward があれば前回値で推定する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-cf-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  // Write state with lastGood (no owner-report)
  fs.writeFileSync(cursorUsagePaceStatePath(home), JSON.stringify({
    fill: true, halt: false, decision: 'behind',
    cursorModelsPct: 5, otherModelsPct: 1, source: 'team-api',
    lastGood: { cursorModelsPct: 5, otherModelsPct: 1, source: 'team-api', at: '2026-11-21T23:17:00+09:00' },
  }));
  const now = Date.parse('2026-11-22T19:30:00+09:00');
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.decision, 'behind');
  assert.equal(result.fill, true);
  assert.match(result.line, /Cursor Models 5\.0%/);
  assert.match(result.line, /取得:前回値\(team-api/);
  assert.match(result.line, /\(推定\)/);
});

test('48h超の前回値は fill しない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-48h-'));
  const dir = path.join(home, '.claude', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerReportPath(home), JSON.stringify({
    cursorModelsPct: 5, otherModelsPct: 1, onDemandUsed: false, at: '2026-11-20T19:00:00+09:00', by: 'kim',
  }));
  const now = Date.parse('2026-11-22T20:00:00+09:00'); // 49h later
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.decision, 'behind');
  assert.equal(result.fill, false, '48h超なので fill しない');
  assert.match(result.line, /追加回し:しない/);
  assert.match(result.line, /\(推定\)/);
});

test('7日超の前回値は％を使わず判定:未取得', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-7d-'));
  const dir = path.join(home, '.claude', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerReportPath(home), JSON.stringify({
    cursorModelsPct: 5, otherModelsPct: 1, onDemandUsed: false, at: '2026-11-14T19:00:00+09:00', by: 'kim',
  }));
  const now = Date.parse('2026-11-22T20:00:00+09:00'); // 8d later
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.decision, 'unknown');
  assert.equal(result.fill, false);
  assert.match(result.line, /Cursor Models —%/);
  assert.match(result.line, /判定:未取得/);
});

test('owner-report の at が不正なら％を使わず判定:未取得', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-badat-'));
  const dir = path.join(home, '.claude', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerReportPath(home), JSON.stringify({
    cursorModelsPct: 5, otherModelsPct: 1, onDemandUsed: false, at: 'invalid-date', by: 'kim',
  }));
  const now = Date.parse('2026-11-22T20:00:00+09:00');
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.decision, 'unknown');
  assert.equal(result.fill, false);
  assert.match(result.line, /Cursor Models —%/);
  assert.match(result.line, /判定:未取得/);
  assert.match(result.line, /取得:owner-report\(at不正\)/);
});

test('halt 時に alert ファイルを書き、halt でなければ書かない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-pace-alert-'));
  const dir = path.join(home, '.claude', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ownerReportPath(home), JSON.stringify({
    cursorModelsPct: 98, otherModelsPct: 1, onDemandUsed: false, at: '2026-11-21T23:17:00+09:00', by: 'kim',
  }));
  const now = Date.parse('2026-11-22T19:30:00+09:00');
  const result = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result.halt, true);
  const alertPath = path.join(home, '.claude', 'reports', 'cursor-usage-pace-alert.txt');
  assert.ok(fs.existsSync(alertPath), 'alert ファイルが存在する');
  assert.match(fs.readFileSync(alertPath, 'utf8'), /従量課金/);
  // 次に halt でない実行で alert が消える
  fs.writeFileSync(ownerReportPath(home), JSON.stringify({
    cursorModelsPct: 5, otherModelsPct: 1, onDemandUsed: false, at: '2026-11-21T23:17:00+09:00', by: 'kim',
  }));
  const result2 = await runCursorUsagePace({
    home,
    now,
    fetchPlanImpl: async () => ({ ok: false, source: 'unavailable' }),
  });
  assert.equal(result2.halt, false);
  assert.equal(fs.existsSync(alertPath), false, 'halt 解除で alert が消える');
});
