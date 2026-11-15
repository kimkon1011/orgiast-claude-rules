# OrgiastReplyLearningNightly: reply-learning nightly loop at 04:40 daily. Existing task is updated. ASCII only.
param([switch]$ValidateOnly, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\reply-learning.mjs', 'tools\reply-queue.mjs')
$script = Join-Path $repo 'tools\reply-learning.mjs'
$nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $nodeExe) { throw 'Node executable missing' }
if ($ValidateOnly) {
  & $nodeExe --check $script
  if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed' }
  Write-Host ('validate only: ' + $script + ' / daily 04:40 / PT40M')
  return
}
if ($Unregister) {
  Unregister-ScheduledTask -TaskName 'OrgiastReplyLearningNightly' -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host 'unregistered: OrgiastReplyLearningNightly'
  return
}
$action = New-HiddenScheduledTaskAction -Execute $nodeExe -ChildArgument @($script, 'nightly') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '04:40'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 40)
Register-ScheduledTask -TaskName 'OrgiastReplyLearningNightly' -Action $action -Trigger @($trigger) -Settings $settings -Description 'Reply-learning nightly loop: Gmail sent-diff intake, rule promotion, weekly metrics, Discord gap check (daily 04:40)' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastReplyLearningNightly' -ErrorAction Stop
if ($task.Settings.ExecutionTimeLimit -ne 'PT40M' -or $task.Actions.Arguments -notlike '*reply-learning.mjs*' -or $task.Actions.Arguments -notlike '*nightly*' -or $task.Triggers[0].StartBoundary -notlike '*T04:40:00*') { throw 'read-back failed: OrgiastReplyLearningNightly' }
& schtasks.exe /Query /TN OrgiastReplyLearningNightly
if ($LASTEXITCODE -ne 0) { throw 'schtasks check failed' }
Write-Host 'registered and read back: OrgiastReplyLearningNightly / daily 04:40 / PT40M'
