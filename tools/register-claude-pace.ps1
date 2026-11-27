# All PCs: hourly Claude plan pace check at :23. Does not kill interactive sessions.
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\claude-pace.mjs')
$script = Join-Path $repo 'tools\claude-pace.mjs'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
if ($ValidateOnly) {
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }
  return
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--once', '--json') -WorkingDirectory $repo
# Hourly at :23 (slot measured free on 018)
$next = (Get-Date).Date.AddHours((Get-Date).Hour).AddMinutes(23)
if ($next -le (Get-Date)) { $next = $next.AddHours(1) }
$trigger = New-ScheduledTaskTrigger -Once -At $next -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 55)
Register-ScheduledTask -TaskName 'OrgiastClaudePace' -Action $action -Trigger $trigger -Settings $settings -Description 'Hourly Claude plan usage pace check (90% landing target; hold at ahead/stopped).' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastClaudePace' -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script) -or $task.Actions.Arguments -notmatch '"--once"' -or $task.Settings.ExecutionTimeLimit -ne 'PT55M' -or $task.Settings.MultipleInstances -ne 'IgnoreNew' -or $task.Triggers[0].Repetition.Interval -ne 'PT1H') { throw 'read-back failed: OrgiastClaudePace' }
$startMinute = ([datetime]$task.Triggers[0].StartBoundary).Minute
if ($startMinute -ne 23) { throw "read-back failed: OrgiastClaudePace start minute is $startMinute, expected 23" }
Write-Host 'OK: OrgiastClaudePace hourly at :23'
