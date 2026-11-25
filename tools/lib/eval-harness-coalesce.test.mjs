import assert from 'node:assert/strict';
import test from 'node:test';
import { runEvalHarnessJobs } from './eval-harness-coalesce.mjs';

test('複数ジョブを1回だけ実行してすべて完了にする', async () => {
  const jobs = [{ id: 'eval-1' }, { id: 'eval-2' }, { id: 'eval-3' }];
  const completed = new Set();
  const calls = [];
  const count = await runEvalHarnessJobs(jobs, async (job) => {
    calls.push(job);
    completed.add(job.id);
  }, completed);

  assert.equal(count, 3);
  assert.deepEqual(calls, [jobs[0]]);
  assert.deepEqual([...completed], jobs.map((job) => job.id));
});

test('実行が失敗したら1件も完了にしない', async () => {
  const jobs = [{ id: 'eval-1' }, { id: 'eval-2' }, { id: 'eval-3' }];
  const completed = new Set();

  await assert.rejects(
    runEvalHarnessJobs(jobs, async () => { throw new Error('failed'); }, completed),
    /failed/,
  );
  assert.deepEqual([...completed], []);
});

test('ジョブが0件なら実行せず0を返す', async () => {
  const completed = new Set();
  let calls = 0;
  const count = await runEvalHarnessJobs([], async () => { calls += 1; }, completed);

  assert.equal(count, 0);
  assert.equal(calls, 0);
  assert.deepEqual([...completed], []);
});
