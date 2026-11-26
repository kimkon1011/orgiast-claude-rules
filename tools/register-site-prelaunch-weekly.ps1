# Register the kim-PC-only weekly site prelaunch check (Monday 06:30).
# ASCII only for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\site-prelaunch-weekly.mjs', 'config\prelaunch-sites.txt')
$script = Join-Path $repo 'tools\site-prelaunch-weekly.mjs'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found (Node 20+ required)' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 6:30am
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 120) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'OrgiastSitePrelaunchWeekly' -Action $action -Trigger $trigger -Settings $settings -Description 'Weekly network-only site prelaunch regression check (Monday 06:30)' -Force | Out-Null
Write-Host 'OK: OrgiastSitePrelaunchWeekly registered (Monday 06:30 local time)'
Get-ScheduledTask -TaskName 'OrgiastSitePrelaunchWeekly' | Select-Object TaskName, State
