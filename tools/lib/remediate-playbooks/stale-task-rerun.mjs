export const name = 'stale-task-rerun';
function inWindow(now, value = '07:00-09:00') { const [a, b] = value.split('-'); const hm = now.getHours() * 60 + now.getMinutes(); const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)); return hm >= mins(a) && hm <= mins(b); }
export async function match(anomaly, context) {
  if (anomaly.type !== 'stale' || !anomaly.expectation?.task || !inWindow(context.now, anomaly.expectation.rerunWindow)) return false;
  const info = await context.tasks.get(anomaly.expectation.task);
  return info?.state === 'Ready' && Number(info.lastTaskResult) !== 0 && !context.reranToday;
}
export async function apply(anomaly, context) { await context.tasks.start(anomaly.expectation.task); context.reranToday = true; return { outcome: 'fixed', note: 'タスクを再実行' }; }
export async function verify(anomaly, context) { return context.waitForLogAdvance(anomaly.log, anomaly.expectation.rerunWaitMinutes || 10); }
