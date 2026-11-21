# Register the morning per-PC cursor-agent run counter (daily 07:10).
# Writes %USERPROFILE%\.claude\reports\cursor-agent-runs.txt
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\cursor-agent-run-counts.mjs')
$script = Join-Path $repo 'tools\cursor-agent-run-counts.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:10am
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'OrgiastCursorAgentRunCounts' -Action $action -Trigger $trigger -Settings $settings -Description 'Count cursor-agent runs on this PC (daily 07:10). Writes %USERPROFILE%\.claude\reports\cursor-agent-runs.txt' -Force | Out-Null
Write-Host 'OK: task OrgiastCursorAgentRunCounts registered (daily 07:10)'
Get-ScheduledTask -TaskName 'OrgiastCursorAgentRunCounts' | Select-Object TaskName, State
