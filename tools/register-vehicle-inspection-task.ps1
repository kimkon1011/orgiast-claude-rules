# Vehicle inspection watch: daily at 09:07 on kim-PC.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
param([switch]$ValidateOnly, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$name = 'OrgiastVehicleInspectionWatch'
if ($Unregister) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  exit 0
}
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\vehicle-inspection-watch.mjs')
$script = Join-Path $repo 'tools\vehicle-inspection-watch.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
if ($ValidateOnly) { & $node --check $script; if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }; return }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '09:07'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Watch vehicle inspection expiry daily at 09:07; notify kim and the assignee, chase until renewed.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script)) { throw "read-back failed: action does not run $script" }
if ($task.Triggers.StartBoundary -notmatch 'T09:07:00') { throw "read-back failed: trigger is $($task.Triggers.StartBoundary)" }
Write-Host "OK: $name daily 09:07"
