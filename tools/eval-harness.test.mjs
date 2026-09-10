import test from 'node:test';
import assert from 'node:assert/strict';
import { isDailyLimit, isUnmeasurable, JUDGE_CHAIN, paretoClassification, recommendations, resolveJudgeChain, resultRecord, retryDelay, suspiciousTasks } from './eval-harness.mjs';

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

const fakeResponse = (retryAfter) => ({ headers: { get: (n) => (n === 'retry-after' ? retryAfter : null) } });

test('isDailyLimit は本文の RPD 文字列で日次上限を判定する', () => {
  assert.equal(isDailyLimit(429, 'Rate limit reached ... on requests per day (RPD): Limit 1000, Used 1000'), true);
  assert.equal(isDailyLimit(429, 'Rate limit reached ... on tokens per minute (TPM): Limit 6000'), false);
  assert.equal(isDailyLimit(500, 'requests per day (RPD)'), false);
  assert.equal(isDailyLimit(429, ''), false);
});

test('retryDelay は retry-after を30秒にクランプする', () => {
  assert.equal(retryDelay(fakeResponse('87'), 0), 30000);
  assert.equal(retryDelay(fakeResponse('5'), 0), 5000);
  assert.equal(retryDelay(fakeResponse(null), 2), 4000);
});

test('resultRecord は空配列でも例外を投げず n:0 rate:null を返す（中断時の部分結果パス）', () => {
  const r = resultRecord('groq', 'm', [], '2026-09-10T00:00:00Z');
  assert.equal(r.n, 0);
  assert.equal(r.rate, null);
  assert.equal(r.attemptedRate, null);
  assert.deepEqual(r.tasks, []);
});

test('resolveJudgeChain は --judge-provider を先頭に置き重複除去する', () => {
  assert.deepEqual(resolveJudgeChain('deepseek'), ['deepseek', 'groq', 'openrouter', 'gemini', 'anthropic']);
  assert.deepEqual(resolveJudgeChain(''), JUDGE_CHAIN);
  assert.equal(new Set(resolveJudgeChain('gemini')).size, JUDGE_CHAIN.length);
});
