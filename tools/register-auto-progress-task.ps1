# Registers the auto-progress tasks (idempotent, Windows PowerShell 5.1 safe: ASCII only).
#   OrgiastAutoProgressWatch  hourly (all PCs) -> tools\auto-progress-watch.mjs
#   OrgiastAutoProgressDigest daily 08:30 / 18:00  (all PCs)
param([switch]$ValidateOnly, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$names = @('OrgiastAutoProgressWatch', 'OrgiastAutoProgressDigest')
if ($Unregister) {
  foreach ($n in $names) { if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $n -Confirm:$false; Write-Host "OK: $n unregistered" } }
  exit 0
}
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\auto-progress-watch.mjs', 'tools\auto-progress-digest.mjs', 'tools\notify-kim.mjs')
$watch = Join-Path $repo 'tools\auto-progress-watch.mjs'
$digest = Join-Path $repo 'tools\auto-progress-digest.mjs'
foreach ($f in @($watch, $digest)) { if (-not (Test-Path -LiteralPath $f)) { throw "missing: $f" } }
if ($ValidateOnly) {
  foreach ($f in @($watch, $digest)) { & $(if (($orgiastNodeExe = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source)) { $orgiastNodeExe } else { "$env:ProgramFiles\nodejs\node.exe" }) --check $f; if ($LASTEXITCODE -ne 0) { throw "node --check failed: $f" } }
  Write-Host 'validate only: OK (no registration)'
  return
}
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
$watchSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 55)
$digestSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$watchSettings.Priority = 4
$digestSettings.Priority = 4

# Bound the hourly watch below its interval: IgnoreNew otherwise refuses overlapping starts.
$watchAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($watch) -WorkingDirectory $repo
$watchTriggers = @((New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Hours 1)))
Register-ScheduledTask -TaskName $names[0] -Action $watchAction -Trigger $watchTriggers -Settings $watchSettings -Description 'Check declared auto-progress promises hourly; resume stalled ones after two hours and report to the owner and fleet sheet.' -Force | Out-Null

$digestAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($digest) -WorkingDirectory $repo
$digestTriggers = @((New-ScheduledTaskTrigger -Daily -At '08:30'), (New-ScheduledTaskTrigger -Daily -At '18:00'))
Register-ScheduledTask -TaskName $names[1] -Action $digestAction -Trigger $digestTriggers -Settings $digestSettings -Description 'Owner push digest of changed local auto-progress items at 08:30 and 18:00 JST.' -Force | Out-Null

foreach ($n in $names) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction Stop
  $expectedScript = if ($n -eq $names[0]) { $watch } else { $digest }
  $expectedTimes = if ($n -eq $names[0]) { @('00:00') } else { @('08:30', '18:00') }
  $actualTimes = @($t.Triggers | ForEach-Object { $_.StartBoundary.Substring(11, 5) } | Sort-Object)
  if (-not $t.Actions.Arguments.Contains($expectedScript) -or ($actualTimes -join ',') -ne ($expectedTimes -join ',')) { throw "read-back failed: $n" }
  if ($t.Settings.Priority -ne 4 -or $t.Settings.StartWhenAvailable -ne $true) { throw "settings read-back failed: $n" }
  if ($n -eq $names[1] -and $t.Settings.ExecutionTimeLimit -ne 'PT10M') { throw "execution limit read-back failed: $n" }
  Write-Host ("OK: {0} state={1} triggers={2}" -f $n, $t.State, (($t.Triggers | ForEach-Object { $_.StartBoundary.Substring(11, 5) }) -join ','))
}
