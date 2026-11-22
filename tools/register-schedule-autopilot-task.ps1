# Register schedule-autopilot on kim-PC (000). ASCII only for Windows PowerShell 5.1.
# Morning digest every day 08:00, tick every 15 minutes (3 hours before deadlines, answers to next step).
param([switch]$DryRun, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\schedule-autopilot.mjs')
$script = Join-Path $repo 'tools\schedule-autopilot.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
& $node --check $script
if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $script" }
$names = @('OrgiastScheduleAutopilotMorning', 'OrgiastScheduleAutopilotTick')
if ($Unregister) {
  foreach ($n in $names) { if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { if ($DryRun) { Write-Host "[DRY] unregister $n" } else { Unregister-ScheduledTask -TaskName $n -Confirm:$false } } }
  return
}
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
$specs = @(
  [pscustomobject]@{ Name = $names[0]; Slot = 'morning'; Trigger = (New-ScheduledTaskTrigger -Daily -At '08:00'); Desc = 'schedule-autopilot morning digest to kim-inbox and mobile push' },
  [pscustomobject]@{ Name = $names[1]; Slot = 'tick'; Trigger = (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15)); Desc = 'schedule-autopilot 15-minute tick: hours-before pushes and answers' }
)
foreach ($spec in $specs) {
  if ($DryRun) { Write-Host "[DRY] $($spec.Name): node $script run --slot $($spec.Slot)"; continue }
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'run', '--slot', $spec.Slot) -WorkingDirectory $repo
  Register-ScheduledTask -TaskName $spec.Name -Action $action -Trigger $spec.Trigger -Settings $settings -Description $spec.Desc -Force | Out-Null
  $actual = Get-ScheduledTask -TaskName $spec.Name -ErrorAction Stop
  if ($actual.Actions[0].Arguments -notmatch 'schedule-autopilot\.mjs' -or $actual.Actions[0].Arguments -notmatch $spec.Slot) { throw "read-back failed: $($spec.Name)" }
  Write-Host "OK: $($spec.Name) registered ($($spec.Slot))"
}
