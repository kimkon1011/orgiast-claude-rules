import { spawnSync } from 'node:child_process';

function run(command, spawnImpl = spawnSync) {
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ErrorActionPreference='Stop';${command}`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
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

export function enableScheduledTask(taskName, { spawnImpl = spawnSync } = {}) {
  const name = String(taskName).replaceAll("'", "''");
  run(`Enable-ScheduledTask -TaskName '${name}' -ErrorAction Stop`, spawnImpl);
}

// System ログ Power-Troubleshooter EventID 1（スリープ復帰）で起動するイベントトリガー。
const WAKE_TRIGGER_PS = `$q='<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>';$c=Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler;$w=New-CimInstance -CimClass $c -ClientOnly;$w.Subscription=$q;$w.Delay='PT1M';$w.Enabled=$true;`;

export function registerHourlyTask(taskName, script, { spawnImpl = spawnSync, home = process.env.USERPROFILE, dryRun = false, wakeTrigger = false, intervalMinutes = 60, executionTimeLimitMinutes = 10, scriptArgs = ['--kill'], interactive = false, initialDelayMinutes = 2, description = 'hook/batch stale process and orphan console cleanup (hourly)' } = {}) {
  if (!Number.isFinite(executionTimeLimitMinutes) || executionTimeLimitMinutes <= 0) throw new Error('Invalid executionTimeLimitMinutes');
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const hidden = pathForPowerShell(home, '.claude\\tools\\run-hidden.vbs');
  const workingDirectory = String(script).replace(/[\\/][^\\/]+$/, '');
  const argumentsText = `//nologo "${hidden}" "${process.execPath}" "${script}" ${scriptArgs.map(arg => `"${arg}"`).join(' ')}`;
  const command = `$a=New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\wscript.exe" -Argument ${quote(argumentsText)} -WorkingDirectory ${quote(workingDirectory)};$t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(${initialDelayMinutes});$r=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(${initialDelayMinutes}) -RepetitionInterval (New-TimeSpan ${intervalMinutes === 60 ? '-Hours 1' : `-Minutes ${intervalMinutes}`});$t.Repetition=$r.Repetition;${wakeTrigger ? WAKE_TRIGGER_PS : ''}$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes ${executionTimeLimitMinutes});${interactive ? "$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;" : ''}Register-ScheduledTask -TaskName ${quote(taskName)} -Action $a -Trigger ${wakeTrigger ? '@($t,$w)' : '$t'} -Settings $s ${interactive ? '-Principal $p' : ''} -Description ${quote(description)} -Force|Out-Null`;
  if (dryRun) return { taskName, execute: 'wscript.exe', arguments: argumentsText, interval: intervalMinutes === 60 ? 'PT1H' : `PT${intervalMinutes}M`, wakeTrigger, executionTimeLimitMinutes };
  return run(command, spawnImpl);
}

function pathForPowerShell(home, suffix) {
  return `${String(home ?? '').replace(/[\\/]+$/, '')}\\${suffix}`;
}

export function listScheduledTasks({ spawnImpl = spawnSync } = {}) {
  const result = run(`@(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Orgiast*' -or $_.TaskName -like 'Claude*' } | ForEach-Object {
    $t=$_;$i=$t|Get-ScheduledTaskInfo
    $last=if($i.LastRunTime){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null}
    $next=if($i.NextRunTime){$i.NextRunTime.ToUniversalTime().ToString('o')}else{$null}
    $cycles=@($t.Triggers | ForEach-Object { if ($_.Repetition.Interval) { [Xml.XmlConvert]::ToTimeSpan($_.Repetition.Interval).TotalMinutes } elseif ($_.DaysInterval) { $_.DaysInterval * 1440 } elseif ($_.WeeksInterval) { $_.WeeksInterval * 10080 } })
    [pscustomobject]@{taskName=($t.TaskPath+$t.TaskName);status=$i.LastTaskResult;t=$last;nextRunTime=$next;neverRun=(!$i.LastRunTime -or $i.LastRunTime.Year -le 1999);running=($t.State -eq 'Running');state=[string]$t.State;cycleMinutes=($cycles|Measure-Object -Minimum).Minimum;location=('taskschd.msc: '+$t.TaskName)}
  })|ConvertTo-Json -Compress`, spawnImpl);
  return result ? (Array.isArray(result) ? result : [result]) : [];
}
