// eval-harness は全provider横断のグローバル計測なので、pending に何件積まれていても実行は1回で足りる。
// 1件ずつ回すと1件あたり約8分 × N で batch-run ロックを一晩(約5時間)占有し、
// 03:27 の夜間バッチがロック競合で毎晩 skip される（2026-09-12/13 の results 実測）。
export async function runEvalHarnessJobs(jobs, runOne, completed) {
  if (!jobs.length) return 0;
  await runOne(jobs[0]);
  for (const job of jobs.slice(1)) completed.add(job.id);
  return jobs.length;
}
