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
if ($Unregister) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "OK: task $taskName unregistered"
  } else {
    Write-Host "OK: task $taskName not found"
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
