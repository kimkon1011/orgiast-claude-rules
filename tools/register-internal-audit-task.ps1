# Weekly read-only audit. Registration and the first DM require the supervisor.
# ASCII only for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\internal-audit.mjs')
$script = Join-Path $repo 'tools\internal-audit.mjs'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found (Node 20+ required)' }
$stateDir = Join-Path $env:USERPROFILE '.claude\internal-audit'
$report = Join-Path $stateDir 'reports\latest.md'
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--notify', '--state-dir', $stateDir, '--out', $report) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 7:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 60) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'OrgiastInternalAudit' -Action $action -Trigger $trigger -Settings $settings -Description 'Read-only internal audit (Monday 07:00), summary DM to kim' -Force | Out-Null
Write-Host 'OK: OrgiastInternalAudit registered (Monday 07:00 local time)'
Get-ScheduledTask -TaskName 'OrgiastInternalAudit' | Select-Object TaskName, State
