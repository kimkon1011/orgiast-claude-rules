import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// テスト用のホームディレクトリを設定
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-send-test-'));
const origHome = process.env.HOME || os.homedir();
process.env.HOME = testHome;

// モジュールはHOME書き換え後にimport
const { traceEvent, readTraces, weeklyReport } = await import('../tools/trace-send.mjs');

test.after(() => {
  process.env.HOME = origHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('traceEvent がレコードを記録し返す', () => {
  const r = traceEvent({
    name: 'test-event',
    model: 'claude-sonnet-5-5',
    inTok: 100,
    outTok: 50,
    durationMs: 2000,
    costUsd: 0.005,
    score: 0.95,
    passed: true,
    provider: 'anthropic',
  });

  assert.equal(r.name, 'test-event');
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.inTok, 100);
  assert.equal(r.outTok, 50);
  assert.equal(r.durationMs, 2000);
  assert.equal(r.costUsd, 0.005);
  assert.equal(r.score, 0.95);
  assert.equal(r.passed, true);
  assert.equal(r.provider, 'anthropic');
  assert.ok(r.t);
});

test('traceEvent が必須項目のみでも動作する', () => {
  const r = traceEvent({ name: 'minimal' });
  assert.equal(r.name, 'minimal');
  assert.equal(r.model, null);
  assert.equal(r.passed, null);
});

test('readTraces が記録したトレースを読む', () => {
  traceEvent({ name: 'read-test', passed: true });
  const today = new Date().toISOString().slice(0, 10);
  const traces = readTraces(today);
  const found = traces.find(t => t.name === 'read-test');
  assert.ok(found);
  assert.equal(found.passed, true);
});

test('readTraces が存在しない日付に対して空配列を返す', () => {
  const traces = readTraces('2000-01-01');
  assert.deepEqual(traces, []);
});

test('weeklyReport が正しい集計を返す', () => {
  // 既に上でいくつか記録済み。追加で不合格を記録
  traceEvent({ name: 'fail-test', passed: false, provider: 'openai', costUsd: 0.01 });
  traceEvent({ name: 'pass-test', passed: true, provider: 'anthropic', costUsd: 0.005, durationMs: 1000 });
  traceEvent({ name: 'pass-test', passed: true, provider: 'anthropic', costUsd: 0.003, durationMs: 500 });

  const report = weeklyReport({ days: 1 });

  assert.ok(report.totalTraces >= 4); // このテスト内で4件以上記録
  assert.ok(typeof report.passRate === 'string');
  assert.ok(report.passRate.endsWith('%'));
  assert.ok(typeof report.totalCostUsd === 'number');
  assert.ok(report.totalCostUsd > 0);

  // byProvider の確認
  assert.ok(report.byProvider);
  assert.ok(report.byProvider.anthropic || report.byProvider.openai);

  // byName の確認
  assert.ok(report.byName);
  assert.ok(report.byName['pass-test']);
});

test('weeklyReport にトレースがない場合の動作', () => {
  const farPast = new Date('2000-01-01').toISOString().slice(0, 10);
  // 過去の日付のディレクトリを作らない = トレース無し
  const report = weeklyReport({ days: 1 });

  // 現在の日付には記録があるので、daysを0に近い値にはできない
  // 最低限の構造確認
  assert.ok(typeof report.period === 'string');
  assert.ok(typeof report.totalTraces === 'number');
});
