# Register the monthly self-test of the deadline-check / visit-consolidation rule on this PC.
# ASCII only for Windows PowerShell 5.1. Daily 09:30 trigger + --monthly guard = runs once per month
# (first run of the month; StartWhenAvailable catches PCs that were off on the 1st).
param([switch]$DryRun, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\deadline-visit-selftest.mjs')
$script = Join-Path $repo 'tools\deadline-visit-selftest.mjs'
$name = 'OrgiastDeadlineVisitSelftestMonthly'
if ($Unregister) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }; return }
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
& $node --check $script
if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $script" }
if ($DryRun) { Write-Host "[DRY] $name : node $script run --monthly"; return }
$settings = New-ScheduledTaskSettingsSet -Priority 6 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -Daily -At '09:30'
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'run', '--monthly') -WorkingDirectory $repo
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'monthly self-test: deadline check and visit consolidation rule (12_)' -Force | Out-Null
$actual = Get-ScheduledTask -TaskName $name -ErrorAction Stop
if ($actual.Actions[0].Arguments -notmatch 'deadline-visit-selftest\.mjs' -or $actual.Actions[0].Arguments -notmatch 'monthly') { throw "read-back failed: $name" }
Write-Host "OK: $name registered"
