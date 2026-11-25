export const name = 'not-yet-first-run';
export async function match(anomaly, context) {
  if (!anomaly.expectation?.task || anomaly.type !== 'missing') return false;
  const info = await context.tasks.get(anomaly.expectation.task);
  return Boolean(info?.neverRun && info.nextRunTime && new Date(info.nextRunTime) > context.now);
}
export async function apply() { return { outcome: 'suppressed', note: '初回未実行' }; }
export async function verify() { return true; }
