# Register kim-PC's notification relay. ASCII only for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\kim-push-relay.mjs')
$script = Join-Path $repo 'tools\kim-push-relay.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
# AtStartup needs admin (Register-ScheduledTask: Access is denied, 2026-11-01).
# Same shape as OrgiastSgaDmWatch: one-time start, repeat every 10 minutes, no Duration = indefinite.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'OrgiastKimPushRelay' -Action $action -Trigger $trigger -Settings $settings -Description 'Relay kim Discord DMs to mobile push every 10 minutes on kim-PC' -Force | Out-Null
Write-Host 'OK: task OrgiastKimPushRelay registered (every 10 minutes)'
Get-ScheduledTask -TaskName 'OrgiastKimPushRelay' | Select-Object TaskName, State
