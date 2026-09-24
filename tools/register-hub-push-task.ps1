# kim master only. Run this same idempotent installer on existing and new kim PCs.
# Daily 02:40 avoids the fixed nightly starts (00:30, 03:00, 03:15, 03:40).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

# Deliberately bind to this master checkout, not another synced fleet checkout.
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'tools\hub-push.mjs'
$onboarding = Join-Path 'C:\Users\uers\Downloads' ('CLAUDE.md' + [char]0x914D + [char]0x5E03 + '\ONBOARDING.md')
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
if (-not (Test-Path -LiteralPath $onboarding)) { throw "kim master not found: $onboarding" }
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '02:40'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'OrgiastHubPush' -Action $action -Trigger $trigger -Settings $settings -Description 'Push kim rule masters to Drive hub daily at 02:40 (JST host)' -Force | Out-Null
Write-Host 'OK: task OrgiastHubPush registered (daily 02:40)'
Get-ScheduledTask -TaskName 'OrgiastHubPush' | Select-Object TaskName, State
