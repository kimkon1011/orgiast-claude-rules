# Register the daily Cursor Ultra pace check (no GUI). Default 19:30 JST on this PC.
# Recommended host is 000. Grok Bot's 20:00 usage review reads:
#   %USERPROFILE%\.claude\reports\cursor-usage-pace.txt
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\cursor-usage-pace.mjs')
$script = Join-Path $repo 'tools\cursor-usage-pace.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:30pm
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'OrgiastCursorUsagePace' -Action $action -Trigger $trigger -Settings $settings -Description 'Measure Cursor Ultra usage vs ideal pace (daily 19:30). Writes %USERPROFILE%\.claude\reports\cursor-usage-pace.txt' -Force | Out-Null
Write-Host 'OK: task OrgiastCursorUsagePace registered (daily 19:30)'
Get-ScheduledTask -TaskName 'OrgiastCursorUsagePace' | Select-Object TaskName, State
