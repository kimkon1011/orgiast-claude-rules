# Register nightly health remediation as a hidden daily task at 07:20.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\nightly-health-remediate.mjs')
$script = Join-Path $repo 'tools\nightly-health-remediate.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:20am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 90)
Register-ScheduledTask -TaskName 'OrgiastNightlyRemediate' -Action $action -Trigger $trigger -Settings $settings -Description 'Repair nightly health anomalies (daily 07:20)' -Force | Out-Null
Write-Host 'OK: task OrgiastNightlyRemediate registered (daily 07:20)'
Get-ScheduledTask -TaskName 'OrgiastNightlyRemediate' | Select-Object TaskName, State
