# Register OrgiastClaudePaceReport: daily 07:30 JST Claude pace digest (host 011, fallback 018).
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\claude-pace-report.mjs', 'config\claude-pace.json')
$script = Join-Path $repo 'tools\claude-pace-report.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
if ($ValidateOnly) {
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'Node syntax check failed' }
  Write-Host ('validate-only: ' + $script + ' / daily 07:30 / PT20M / IgnoreNew')
  return
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:30am
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName 'OrgiastClaudePaceReport' -Action $action -Trigger $trigger -Settings $settings -Description 'Claude pace daily report (07:30 JST). Primary host 011; fallback 018 when 011 ledger is stale.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastClaudePaceReport' -ErrorAction Stop
if ($task.TaskName -ne 'OrgiastClaudePaceReport') { throw 'read-back failed: OrgiastClaudePaceReport' }
if ($task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'read-back failed: MultipleInstances' }
if ($task.Settings.ExecutionTimeLimit -ne 'PT20M') { throw 'read-back failed: ExecutionTimeLimit' }
Write-Host 'OK: task OrgiastClaudePaceReport registered (daily 07:30, IgnoreNew, PT20M)'
Get-ScheduledTask -TaskName 'OrgiastClaudePaceReport' | Select-Object TaskName, State
