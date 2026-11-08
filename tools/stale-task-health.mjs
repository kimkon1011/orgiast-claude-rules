import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One attempt per local calendar day; persist results for diagnosis and notify retry.
export async function runStaleTaskHealth({ home, now = new Date(), platform = process.platform,
  dryRun = false, spawn = spawnSync } = {}) {
  if (platform !== 'win32' || dryRun) return { anomalies: [] };
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'stale-task-health.json');
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  if (state?.day === day) return { anomalies: state.anomalies || [] };
  const out = path.join(dir, `stale-task-plan-${process.pid}.json`);
  const script = fileURLToPath(new URL('./repair-task-paths.ps1', import.meta.url));
  const anomalies = [];
  // Mark before invoking, so a failed process is not repeatedly launched all day.
  const save = () => fs.writeFileSync(statePath, JSON.stringify({ day, anomalies }, null, 2));
  anomalies.push({ type: 'stale_task_error', label: '定期タスク参照先', message: '修復処理が完了していません' });
  save();
  try {
    const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Apply', '-OutJson', out], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    const plan = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '')) || [];
    const stale = plan.filter(item => item.Status !== 'pinned:auto-session');
    const repaired = stale.filter(item => item.Status === 'repaired');
    anomalies.length = 0;
    if (stale.length || result.status !== 0 || result.error) {
      anomalies.push({ type: 'stale_task_paths', label: '定期タスク参照先',
        message: `検出 ${stale.length} / 修復 ${repaired.length} / pinned ${plan.length - stale.length} / exit ${result.status}: ` +
          stale.map(item => `${item.TaskName}[${item.Index}] ${item.Status}: ${item.OldExecute} ${item.OldArguments} ${item.OldWorkingDirectory || ''} → ${item.NewExecute} ${item.NewArguments} ${item.NewWorkingDirectory || ''}`).join('; ') });
    }
    fs.writeFileSync(path.join(dir, 'stale-task-health-last.log'), `${result.stdout || ''}\n${result.stderr || ''}`);
  } catch (error) {
    anomalies.splice(0, anomalies.length, { type: 'stale_task_error', label: '定期タスク参照先', message: error.message });
  } finally {
    fs.rmSync(out, { force: true });
    save();
  }
  return { anomalies };
}
