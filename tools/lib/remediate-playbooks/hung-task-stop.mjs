export const name = 'hung-task-stop';
export async function match(anomaly, context) {
  // 画面を検出しただけの異常で監視タスクを止めると、ダイアログを閉じる唯一の手段が
  // 失われ、playbook-error で escalated も記録されない。停止対象は「監視が死んだ」
  // 系の異常だけにする。
  if (anomaly.type === 'stuck_dialog') return false;
  const exp = anomaly.expectation; if (!exp?.task || !exp.maxRunHours) return false;
  const info = await context.tasks.get(exp.task);
  return info?.state === 'Running' && context.now - new Date(info.lastRunTime) > exp.maxRunHours * 3600000;
}
export async function apply(anomaly, context) { await context.tasks.stop(anomaly.expectation.task); return { outcome: 'fixed', note: '長時間実行タスクを停止' }; }
export async function verify(anomaly, context) { const info = await context.tasks.get(anomaly.expectation.task); return Boolean(info && info.state !== 'Running'); }
