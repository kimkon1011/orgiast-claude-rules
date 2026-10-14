# Registers the auto-progress tasks (idempotent, Windows PowerShell 5.1 safe: ASCII only).
#   OrgiastAutoProgressWatch  daily 09:00 + 18:00  (all PCs)  -> tools\auto-progress-watch.mjs
#   OrgiastAutoProgressDigest daily 08:40          (all PCs; the tool itself exits unless label is kim-PC)
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
  foreach ($f in @($watch, $digest)) { & node --check $f; if ($LASTEXITCODE -ne 0) { throw "node --check failed: $f" } }
  Write-Host 'validate only: OK (no registration)'
  return
}
$node = (Get-Command node -ErrorAction Stop).Source
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 60)

$watchAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($watch) -WorkingDirectory $repo
$watchTriggers = @((New-ScheduledTaskTrigger -Daily -At '09:00'), (New-ScheduledTaskTrigger -Daily -At '18:00'))
Register-ScheduledTask -TaskName $names[0] -Action $watchAction -Trigger $watchTriggers -Settings $settings -Description 'Check declared auto-progress promises twice a day (09:00/18:00); resume stalled ones once a day and report to the fleet sheet.' -Force | Out-Null

$digestAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($digest) -WorkingDirectory $repo
$digestTrigger = New-ScheduledTaskTrigger -Daily -At '08:40'
Register-ScheduledTask -TaskName $names[1] -Action $digestAction -Trigger $digestTrigger -Settings $settings -Description 'Morning DM digest of stalled auto-progress items (runs on kim-PC only, no-op elsewhere).' -Force | Out-Null

foreach ($n in $names) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction Stop
  $expectedScript = if ($n -eq $names[0]) { $watch } else { $digest }
  $expectedTimes = if ($n -eq $names[0]) { @('09:00', '18:00') } else { @('08:40') }
  $actualTimes = @($t.Triggers | ForEach-Object { $_.StartBoundary.Substring(11, 5) } | Sort-Object)
  if (-not $t.Actions.Arguments.Contains($expectedScript) -or ($actualTimes -join ',') -ne ($expectedTimes -join ',')) { throw "read-back failed: $n" }
  Write-Host ("OK: {0} state={1} triggers={2}" -f $n, $t.State, (($t.Triggers | ForEach-Object { $_.StartBoundary.Substring(11, 5) }) -join ','))
}
