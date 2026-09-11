import { spawnSync } from 'node:child_process';

function run(command, spawnImpl = spawnSync) {
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || `powershell exit ${result.status}`);
  const text = String(result.stdout || '').trim();
  return text ? JSON.parse(text) : null;
}

export function getScheduledTaskInfo(taskName, { spawnImpl = spawnSync } = {}) {
  const name = String(taskName).replaceAll("'", "''");
  const command = `try{$t=Get-ScheduledTask -TaskName '${name}' -ErrorAction Stop;$i=Get-ScheduledTaskInfo -TaskName '${name}' -ErrorAction Stop;[pscustomobject]@{taskName=$t.TaskName;state=[string]$t.State;lastRunTime=$i.LastRunTime.ToString('o');nextRunTime=$i.NextRunTime.ToString('o');lastTaskResult=$i.LastTaskResult;neverRun=($i.LastRunTime.Year -le 1999)}|ConvertTo-Json -Compress}catch{if($_.FullyQualifiedErrorId -match 'NoMatchingMSFT_ScheduledTaskFound'){Write-Output 'null'}else{throw}}`;
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

export function registerHourlyTask(taskName, script, { spawnImpl = spawnSync, home = process.env.USERPROFILE, dryRun = false } = {}) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const hidden = pathForPowerShell(home, '.claude\\tools\\run-hidden.vbs');
  const workingDirectory = String(script).replace(/[\\/][^\\/]+$/, '');
  const argumentsText = `//nologo "${hidden}" "${process.execPath}" "${script}" "--kill"`;
  const command = `$a=New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\wscript.exe" -Argument ${quote(argumentsText)} -WorkingDirectory ${quote(workingDirectory)};$t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2);$r=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1);$t.Repetition=$r.Repetition;$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10);Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Trigger $t -Settings $s -Description 'hook/batch stale process cleanup (hourly)' -Force|Out-Null`;
  if (dryRun) return { taskName, execute: 'wscript.exe', arguments: argumentsText, interval: 'PT1H' };
  return run(command, spawnImpl);
}

function pathForPowerShell(home, suffix) {
  return `${String(home ?? '').replace(/[\\/]+$/, '')}\\${suffix}`;
}
