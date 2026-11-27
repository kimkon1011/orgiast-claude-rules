# Register the monthly self-test of the deadline-check / visit-consolidation rule (portable-knowhow 12_) on this PC.
# ASCII only for Windows PowerShell 5.1. Copies the self-updating runner to ~/.claude/deadline-visit-test and registers
# a daily 09:30 trigger; the runner's --monthly guard makes it run once per month (StartWhenAvailable catches PCs off on the 1st).
param([switch]$DryRun, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$name = 'OrgiastDeadlineVisitSelftestMonthly'
if ($Unregister) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }; return }
$base = Join-Path $env:USERPROFILE '.claude\deadline-visit-test'
New-Item -ItemType Directory -Force -Path $base | Out-Null
$ps1 = Join-Path $base 'run-deadline-visit-selftest.ps1'
Copy-Item -Force -LiteralPath (Join-Path $PSScriptRoot 'deadline-visit-selftest-run.ps1') -Destination $ps1
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if ($DryRun) { Write-Host "[DRY] $name : $ps -File $ps1 -Monthly"; return }
$action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ps1 + '" -Monthly')
$trigger = New-ScheduledTaskTrigger -Daily -At '09:30'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'monthly self-test of the deadline-check / visit-consolidation rule (portable-knowhow 12_)' -Force | Out-Null
$t = Get-ScheduledTask -TaskName $name
if ($t.Actions[0].Arguments -notmatch 'run-deadline-visit-selftest\.ps1' -or $t.Actions[0].Arguments -notmatch 'Monthly') { throw "read-back failed: $name" }
Write-Host ("OK: $name registered, next " + (Get-ScheduledTaskInfo -TaskName $name).NextRunTime.ToString('yyyy-MM-dd HH:mm'))
