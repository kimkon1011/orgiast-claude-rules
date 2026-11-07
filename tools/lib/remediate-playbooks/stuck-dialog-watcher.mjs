export const name = 'stuck-dialog-watcher';
export async function match(anomaly) {
  return anomaly.type === 'watcher_dead' || (anomaly.expectation?.task === 'OrgiastStuckDialogWatch' && ['missing','stale','task_missed'].includes(anomaly.type));
}
export async function apply(anomaly, context) {
  await context.repairDialogWatcher();
  return { outcome: 'fixed', note: '監視タスクを再登録・開始し、正常な生存報告を確認' };
}
export async function verify(anomaly, context) { return context.verifyDialogWatcher(); }
