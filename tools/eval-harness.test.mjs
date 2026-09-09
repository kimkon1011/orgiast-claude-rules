import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call, isUnmeasurable, paretoClassification, recommendations, resultRecord, suspiciousTasks } from './eval-harness.mjs';
import { nextUtcDay } from './provider-cooldown.mjs';

function isolatedCooldown(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-harness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'provider-cooldown.json');
}

function withGroqKey(t) {
  const original = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-key';
  t.after(() => { if (original === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = original; });
}

function task(id, category, status, extra = {}) {
  return { id, category, status, pass: status === 'pass', costUsd: 0.001, ms: 10, ...extra };
}

test('attemptedRate は pass/n、既存 rate は pass/graded のまま', () => {
  const r = resultRecord('p', 'm', [task('a', 'cat', 'pass'), task('b', 'cat', 'fail'), task('c', 'cat', 'error')], '2026-08-26T00:00:00Z');
  assert.equal(r.attemptedRate, 1 / 3);
  assert.equal(r.rate, 1 / 2);
  assert.deepEqual(r.tasks, [
    { id: 'a', category: 'cat', pass: true, status: 'pass' },
    { id: 'b', category: 'cat', pass: false, status: 'fail' },
    { id: 'c', category: 'cat', pass: false, status: 'error' }
  ]);
});

test('errors + truncated が n の1割超なら計測不能で推薦されない', () => {
  const bad = resultRecord('quota', 'flash', [task('ok', 'cat', 'pass'), ...Array.from({ length: 8 }, (_, i) => task(`p${i}`, 'cat', 'pass')), task('e1', 'cat', 'error'), task('e2', 'cat', 'truncated')]);
  const good = resultRecord('stable', 'model', Array.from({ length: 11 }, (_, i) => task(`g${i}`, 'cat', i ? 'pass' : 'fail')));
  assert.equal(isUnmeasurable(bad), true);
  assert.equal(paretoClassification(bad), '🚫計測不能 (エラー1件・切断1件)');
  const output = recommendations([bad, good]).join('\n');
  assert.doesNotMatch(output, /quota\/flash/);
  assert.match(output, /stable\/model/);
});

test('半数以上が fail/error のタスクは警告され推薦根拠から外れる', () => {
  const rows = [
    resultRecord('a', 'm', [task('rep-03', 'jp_reply', 'fail'), task('good', 'jp_reply', 'pass')]),
    resultRecord('b', 'm', [task('rep-03', 'jp_reply', 'error'), task('good', 'jp_reply', 'pass')]),
    resultRecord('c', 'm', [task('rep-03', 'jp_reply', 'pass'), task('good', 'jp_reply', 'pass')])
  ];
  assert.deepEqual(suspiciousTasks(rows), [{ id: 'rep-03', participants: 3, failed: 2 }]);
  const output = recommendations(rows).join('\n');
  assert.match(output, /タスク rep-03: 3プロバイダ中2で失敗/);
  assert.match(output, /成功率 100%/);
});

test('日次上限の429は待機もリトライもせずUTC日境界までcooldownにする', async (t) => {
  withGroqKey(t);
  const cooldownFile = isolatedCooldown(t), now = Date.parse('2026-09-10T03:00:00Z');
  let fetches = 0; const waits = [];
  await assert.rejects(call('groq', 'model', 'prompt', '', 10, {
    cooldownFile, now: () => now,
    fetchImpl: async () => { fetches++; return new Response('{"error":{"message":"Rate limit reached on requests per day (RPD)"}}', { status: 429 }); },
    sleepImpl: async (ms) => waits.push(ms),
  }), /429:.*RPD/);
  assert.equal(fetches, 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(cooldownFile, 'utf8')).groq, {
    until: nextUtcDay(now), reason: 'daily_quota', at: now,
  });
});

test('通常の429は従来どおり最大3回リトライする', async (t) => {
  withGroqKey(t);
  const cooldownFile = isolatedCooldown(t), waits = [];
  let fetches = 0;
  const result = await call('groq', 'model', 'prompt', '', 10, {
    cooldownFile,
    fetchImpl: async () => ++fetches <= 3
      ? new Response('{"error":{"message":"temporary rate limit"}}', { status: 429 })
      : Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(result.text, 'ok');
  assert.equal(fetches, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('cooldown中のプロバイダはfetchを呼ばずスキップする', async (t) => {
  withGroqKey(t);
  const cooldownFile = isolatedCooldown(t), now = Date.parse('2026-09-10T03:00:00Z');
  fs.writeFileSync(cooldownFile, JSON.stringify({ groq: { until: now + 60000, reason: 'daily_quota', at: now - 1 } }));
  let fetches = 0;
  await assert.rejects(call('groq', 'model', 'prompt', '', 10, {
    cooldownFile, now: () => now, fetchImpl: async () => { fetches++; return Response.json({}); },
  }), /SKIP groq: cooldown中 \(daily_quota, 残り1分\)/);
  assert.equal(fetches, 0);
});
