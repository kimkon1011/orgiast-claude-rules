# All PCs: archive disposable sessions every hour at :15, without deleting them.
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\session-cap-enforce.mjs')
$script = Join-Path $repo 'tools\session-cap-enforce.mjs'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
if ($ValidateOnly) {
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }
  return
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(15) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'OrgiastSessionCapEnforce' -Action $action -Trigger $trigger -Settings $settings -Description 'Archive disposable VS Code sessions hourly; no deletion, protect busy sessions.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastSessionCapEnforce' -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script) -or $task.Actions.Arguments -notmatch 'run-hidden\.vbs' -or $task.Actions.Execute -notmatch 'wscript\.exe$' -or $task.Triggers[0].StartBoundary.Substring(11,5) -ne '00:15' -or $task.Triggers[0].Repetition.Interval -ne 'PT1H' -or $task.Settings.ExecutionTimeLimit -ne 'PT10M' -or $task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'read-back failed: OrgiastSessionCapEnforce' }
Write-Host 'OK: OrgiastSessionCapEnforce hourly :15'
