# Register OrgiastClaudePaceReportWatch: daily 07:45 JST claude-pace report missing detector.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\claude-pace-report-watch.mjs')
$script = Join-Path $repo 'tools\claude-pace-report-watch.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
if ($ValidateOnly) {
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed' }
  Write-Host ('validate-only: ' + $script + ' / daily 07:45 / PT10M / IgnoreNew')
  return
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:45am
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'OrgiastClaudePaceReportWatch' -Action $action -Trigger $trigger -Settings $settings -Description 'Claude pace report watch (07:45 JST). Warns kim when the day report is missing.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastClaudePaceReportWatch' -ErrorAction Stop
if ($task.TaskName -ne 'OrgiastClaudePaceReportWatch') { throw 'read-back failed: task name' }
if ($task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'read-back failed: MultipleInstances' }
if ($task.Settings.ExecutionTimeLimit -ne 'PT10M') { throw 'read-back failed: ExecutionTimeLimit' }
Write-Host 'OK: task OrgiastClaudePaceReportWatch registered (daily 07:45, IgnoreNew, PT10M)'
Get-ScheduledTask -TaskName 'OrgiastClaudePaceReportWatch' | Select-Object TaskName, State