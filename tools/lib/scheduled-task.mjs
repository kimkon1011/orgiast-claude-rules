import { spawnSync } from 'node:child_process';

function run(command, spawnImpl = spawnSync) {
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || `powershell exit ${result.status}`);
  const text = String(result.stdout || '').trim();
  return text ? JSON.parse(text) : null;
}

export function getScheduledTaskInfo(taskName, { spawnImpl = spawnSync } = {}) {
  const name = String(taskName).replaceAll("'", "''");
  const command = `$t=Get-ScheduledTask -TaskName '${name}' -ErrorAction Stop;$i=Get-ScheduledTaskInfo -TaskName '${name}' -ErrorAction Stop;[pscustomobject]@{taskName=$t.TaskName;state=[string]$t.State;lastRunTime=$i.LastRunTime.ToString('o');nextRunTime=$i.NextRunTime.ToString('o');lastTaskResult=$i.LastTaskResult;neverRun=($i.LastRunTime.Year -le 1999)}|ConvertTo-Json -Compress`;
  return Promise.resolve(run(command, spawnImpl));
}

export function startScheduledTask(taskName, { spawnImpl = spawnSync } = {}) {
  const name = String(taskName).replaceAll("'", "''");
  run(`Start-ScheduledTask -TaskName '${name}' -ErrorAction Stop`, spawnImpl);
}

export function stopScheduledTask(taskName, { spawnImpl = spawnSync } = {}) {
  const name = String(taskName).replaceAll("'", "''");
  run(`Stop-ScheduledTask -TaskName '${name}' -ErrorAction Stop`, spawnImpl);
}
