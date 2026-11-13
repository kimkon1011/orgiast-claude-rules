# All PCs: unclosed session sweep, daily 06:30. Registration through setup manifest.
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\morning-session-sweep.mjs')
$script = Join-Path $repo 'tools\morning-session-sweep.mjs'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
if ($ValidateOnly) {
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }
  return
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '06:30'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'OrgiastMorningSessionSweep' -Action $action -Trigger $trigger -Settings $settings -Description 'Report all unclosed sessions from the last seven days to kim-inbox via fleet.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastMorningSessionSweep' -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script) -or $task.Triggers[0].StartBoundary.Substring(11,5) -ne '06:30') { throw 'read-back failed: OrgiastMorningSessionSweep' }
Write-Host 'OK: OrgiastMorningSessionSweep daily 06:30'
