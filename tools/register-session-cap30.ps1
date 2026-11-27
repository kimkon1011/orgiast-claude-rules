# All PCs: reversible session cap, daily 04:40 (04:30 is used by role sessions).
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\session-cap.mjs')
$script = Join-Path $repo 'tools\session-cap.mjs'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
if ($ValidateOnly) {
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }
  return
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--cap', '30') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '04:40'
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'OrgiastSessionCap30' -Action $action -Trigger $trigger -Settings $settings -Description 'Keep visible VS Code sessions at 30; protect active/pending sessions and archive reversibly.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastSessionCap30' -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script) -or $task.Actions.Arguments -notmatch '"--cap"\s+"30"' -or $task.Triggers[0].StartBoundary.Substring(11,5) -ne '04:40' -or $task.Settings.ExecutionTimeLimit -ne 'PT10M' -or $task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'read-back failed: OrgiastSessionCap30' }
Write-Host 'OK: OrgiastSessionCap30 daily 04:40'
