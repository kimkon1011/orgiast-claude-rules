import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnmeasurable, paretoClassification, recommendations, resultRecord, suspiciousTasks } from './eval-harness.mjs';

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
