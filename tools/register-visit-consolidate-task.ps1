# Register the daily visit/mail consolidation check on kim-PC (000). ASCII only for Windows PowerShell 5.1.
# Every day 07:40 (before the 08:00 schedule-autopilot digest): reads the deadline ledger, writes
# ~/.claude/deadline-watch/visit-consolidation.md. Read-only, sends nothing.
param([switch]$DryRun, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\visit-consolidate.mjs')
$script = Join-Path $repo 'tools\visit-consolidate.mjs'
$name = 'OrgiastVisitConsolidateDaily'
if ($Unregister) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }; return }
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
& $node --check $script
if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $script" }
if ($DryRun) { Write-Host "[DRY] $name : node $script run"; return }
$settings = New-ScheduledTaskSettingsSet -Priority 6 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -Daily -At '07:40'
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'run') -WorkingDirectory $repo
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'daily: match visit/mail plans against all cases in the deadline ledger' -Force | Out-Null
$actual = Get-ScheduledTask -TaskName $name -ErrorAction Stop
if ($actual.Actions[0].Arguments -notmatch 'visit-consolidate\.mjs') { throw "read-back failed: $name" }
Write-Host "OK: $name registered"
