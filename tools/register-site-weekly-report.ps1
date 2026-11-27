# ASCII only. Register site weekly report + unanswered check on this PC's Task Scheduler.
# Weekly: Wed 10:30 local (JST on 011). Unanswered: daily 10:00 local.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\site-weekly-report.mjs', 'config\site-weekly-report.json')
$script = Join-Path $repo 'tools\site-weekly-report.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js 20 or newer first.' }

$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$settings.Priority = 4
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$weeklyAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$weeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Wednesday -At 10:30am
Register-ScheduledTask -TaskName 'OrgiastSiteWeeklyReport' -Action $weeklyAction -Trigger $weeklyTrigger -Settings $settings -Principal $principal -Description 'Corporate site weekly GA4+inquiry report to Discord (Wed 10:30)' -Force | Out-Null

$unansweredAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--check-unanswered') -WorkingDirectory $repo
$unansweredTrigger = New-ScheduledTaskTrigger -Daily -At 10:00am
Register-ScheduledTask -TaskName 'OrgiastSiteWeeklyUnanswered' -Action $unansweredAction -Trigger $unansweredTrigger -Settings $settings -Principal $principal -Description 'Inquiry unanswered reminder to Discord (daily 10:00)' -Force | Out-Null

Write-Host 'OK: OrgiastSiteWeeklyReport (Wed 10:30) and OrgiastSiteWeeklyUnanswered (daily 10:00) registered.'
Get-ScheduledTask -TaskName 'OrgiastSiteWeeklyReport','OrgiastSiteWeeklyUnanswered' | Select-Object TaskName, State | Format-Table -AutoSize
