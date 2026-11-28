# Register OrgiastFollowupLedger: run followup-ledger check every 15 minutes.
# Each PC can register via converge / fleet-directive:
#   powershell -ExecutionPolicy Bypass -File tools\register-followup-ledger.ps1
# Quiet hours (22:00-07:00 JST) are enforced inside followup-ledger.mjs (nudge deferred).
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
param(
  [switch]$Unregister,
  [switch]$RunNow
)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastFollowupLedger'
$morningTaskName = 'OrgiastFollowupLedgerMorning'
if ($Unregister) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "OK: task $taskName unregistered"
  } else {
    Write-Host "OK: task $taskName not found"
  }
  if (Get-ScheduledTask -TaskName $morningTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $morningTaskName -Confirm:$false
  }
  exit 0
}
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\followup-ledger.mjs')
$script = Join-Path $repo 'tools\followup-ledger.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'check') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Follow up outstanding requests until done (every 15 min; quiet hours in script)' -Force | Out-Null
Write-Host "OK: task $taskName registered (every 15 minutes)"
if ($RunNow) {
  Start-ScheduledTask -TaskName $taskName
  Write-Host "OK: Start-ScheduledTask $taskName"
}
schtasks /Query /TN $taskName /V /FO LIST

# Explicit JST offset: the morning report stays at 07:30 JST on every PC.
$morningAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'report', '--morning', '--kim-inbox') -WorkingDirectory $repo
$jstToday = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(9)).ToString('yyyy-MM-dd')
$morningTrigger = New-ScheduledTaskTrigger -Daily -At '07:30'
$morningTrigger.StartBoundary = "${jstToday}T07:30:00+09:00"
Register-ScheduledTask -TaskName $morningTaskName -Action $morningAction -Trigger $morningTrigger -Settings $settings -Description 'Followup ledger morning report (07:30 JST; internal kim-inbox only)' -Force | Out-Null
Write-Host "OK: task $morningTaskName registered (07:30 JST)"
