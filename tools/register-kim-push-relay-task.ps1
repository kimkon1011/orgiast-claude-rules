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
$trigger = New-ScheduledTaskTrigger -AtStartup
# Omit Duration so repetition continues indefinitely.
$repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)).Repetition
$trigger.Repetition = $repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'OrgiastKimPushRelay' -Action $action -Trigger $trigger -Settings $settings -Description 'Relay kim Discord DMs to mobile push every 10 minutes on kim-PC' -Force | Out-Null
Write-Host 'OK: task OrgiastKimPushRelay registered (startup, every 10 minutes)'
Get-ScheduledTask -TaskName 'OrgiastKimPushRelay' | Select-Object TaskName, State
