# ASCII only for Windows PowerShell 5.1.
# Sibling of the GB-63 deadline-watch / deadline-detect seat (kim-PC / 000).
# Pushes timed reminders (calls, meetings, due clocks) shortly before the start.
param([switch]$ValidateOnly, [switch]$DryRun, [switch]$Ensure, [Alias('Remove')][switch]$Unregister)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
$seatRaw = & $node (Join-Path $PSScriptRoot 'setup-deadline-watch.mjs') --seat-check
if ($LASTEXITCODE -ne 0) { throw 'seat check failed' }
$seat = $seatRaw | ConvertFrom-Json
$taskName = 'OrgiastSchedulePush'
$scriptName = 'schedule-push.mjs'
if (-not $seat.kim) {
  $current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($current -and $current.State -ne 'Disabled') {
    if ($DryRun) { Write-Host "[DRY] disable $taskName (reason: no kim DWD key on this seat)" }
    else { Disable-ScheduledTask -TaskName $taskName; Write-Host "disabled: $taskName (reason: no kim DWD key on this seat)" }
  } else { if ($DryRun) { Write-Host "[DRY] $taskName not changed (already disabled or absent)" } }
  return
}
if ($Unregister) {
  if (-not $DryRun -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }
  return
}
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @("tools\$scriptName")
$script = Join-Path $repo ("tools\" + $scriptName)
if (-not (Test-Path -LiteralPath $script)) { throw "Merge and sync main first: missing $script" }
& $node --check $script
if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $script" }
if ($ValidateOnly) { Write-Host 'ok: schedule-push syntax'; return }
$current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$expectedArgs = '//nologo "{0}" "{1}" "{2}" tick' -f $hidden, $node, $script
$matches = $current -and @($current.Actions).Count -eq 1 -and
  $current.Actions[0].Execute -ieq $wscript -and
  $current.Actions[0].Arguments -eq $expectedArgs -and
  $current.Actions[0].WorkingDirectory -eq $repo -and
  @($current.Triggers).Count -eq 1 -and
  $current.Triggers[0].Repetition.Interval -eq 'PT5M' -and
  $current.State -ne 'Disabled'
if ($Ensure -and $matches) { Write-Host 'ok: OrgiastSchedulePush already registered'; return }
if ($DryRun) { Write-Host "[DRY] ${taskName}: $script every 5 minutes"; return }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'tick') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Push kim reminders 30 minutes before timed calls, meetings, and deadlines' -Force | Out-Null
$actual = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($actual.Actions[0].Arguments -ne $expectedArgs -or $actual.Triggers[0].Repetition.Interval -ne 'PT5M') { throw 'schedule-push task read-back failed' }
Write-Host 'ok: OrgiastSchedulePush registered (5 minutes, synced main)'
