# Register kim's local-master push; preserve the existing daily 02:40 task.
# ASCII only for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')

# Prefer the synced repo so the task runs code kept up to date.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\hub-push.mjs')
$script = Join-Path $repo 'tools\hub-push.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '02:40'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'OrgiastHubPush' -Action $action -Trigger $trigger -Settings $settings -Description 'Push kim local rules and skills to the Drive hub (daily 02:40)' -Force | Out-Null
Write-Host 'OK: task OrgiastHubPush registered (daily 02:40)'
Get-ScheduledTask -TaskName 'OrgiastHubPush' | Select-Object TaskName, State
