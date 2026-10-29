# Register hourly LINE log export as a hidden scheduled task.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\line-log-export.mjs')
$script = Join-Path $repo 'tools\line-log-export.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'OrgiastLineLogExport' -Action $action -Trigger $trigger -Settings $settings -Description 'LINE channel_messages を毎時 Google シートへ追記' -Force | Out-Null
Write-Host 'OK: task OrgiastLineLogExport registered (hourly)'
Get-ScheduledTask -TaskName 'OrgiastLineLogExport' | Select-Object TaskName, State
