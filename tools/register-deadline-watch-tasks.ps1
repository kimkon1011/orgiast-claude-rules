# ASCII only for Windows PowerShell 5.1.
param([switch]$ValidateOnly, [switch]$DryRun, [switch]$Ensure, [Alias('Remove')][switch]$Unregister)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
$seatRaw = & $node (Join-Path $PSScriptRoot 'setup-deadline-watch.mjs') --seat-check
if ($LASTEXITCODE -ne 0) { throw 'seat check failed' }
$seat = $seatRaw | ConvertFrom-Json
if (-not $seat.kim) {
  foreach ($spec in $specs) {
    $current = Get-ScheduledTask -TaskName $spec.Name -ErrorAction SilentlyContinue
    if ($current -and $current.State -ne 'Disabled') {
      if ($DryRun) { Write-Host "[DRY] disable $($spec.Name) (reason: no kim DWD key on this seat)" }
      else { Disable-ScheduledTask -TaskName $spec.Name; Write-Host "disabled: $($spec.Name) (reason: no kim DWD key on this seat)" }
    } else { if ($DryRun) { Write-Host "[DRY] $($spec.Name) not changed (already disabled or absent)" } }
  }
  return
}
$specs = @(
  [pscustomobject]@{ Name = 'OrgiastDeadlineDetect'; Script = 'deadline-detect.mjs'; At = '02:40' },
  [pscustomobject]@{ Name = 'OrgiastDeadlineWatch'; Script = 'deadline-watch.mjs'; At = '08:30' }
)
if ($Unregister) {
  foreach ($spec in $specs) {
    if (-not $DryRun -and (Get-ScheduledTask -TaskName $spec.Name -ErrorAction SilentlyContinue)) { Unregister-ScheduledTask -TaskName $spec.Name -Confirm:$false }
  }
  return
}
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @('tools\deadline-detect.mjs','tools\deadline-watch.mjs')
# Validate all executables before changing either task.
foreach ($spec in $specs) {
  $script = Join-Path $repo ('tools\' + $spec.Script)
  if (-not (Test-Path -LiteralPath $script)) { throw "Merge and sync main first: missing $script" }
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $script" }
}
if ($ValidateOnly) { Write-Host 'ok: deadline-watch syntax'; return }
foreach ($spec in $specs) {
  $script = Join-Path $repo ('tools\' + $spec.Script)
  $current = Get-ScheduledTask -TaskName $spec.Name -ErrorAction SilentlyContinue
  $boundary = 'T' + $spec.At + ':00'
  $hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
  $expectedArgs = '//nologo "{0}" "{1}" "{2}"' -f $hidden, $node, $script
  $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  $matches = $current -and @($current.Actions).Count -eq 1 -and
    $current.Actions[0].Execute -ieq $wscript -and
    $current.Actions[0].Arguments -eq $expectedArgs -and
    $current.Actions[0].WorkingDirectory -eq $repo -and
    @($current.Triggers).Count -eq 1 -and $current.Triggers[0].StartBoundary -match $boundary -and
    $current.Triggers[0].DaysInterval -eq 1 -and $current.State -ne 'Disabled'
  if ($Ensure -and $matches) { Write-Host "ok: $($spec.Name) already registered"; continue }
  if ($DryRun) { Write-Host "[DRY] $($spec.Name) $($spec.At): $script"; continue }
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Daily -At $spec.At
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 55)
  Register-ScheduledTask -TaskName $spec.Name -Action $action -Trigger $trigger -Settings $settings -Description 'Track obligations in the deadline ledger; deliver to session inbox.' -Force | Out-Null
  $actual = Get-ScheduledTask -TaskName $spec.Name -ErrorAction Stop
  if ($actual.Actions[0].Arguments -ne $expectedArgs -or $actual.Actions[0].Execute -ine $wscript -or $actual.Triggers[0].StartBoundary -notmatch $boundary) { throw "read-back failed: $($spec.Name)" }
  Write-Host "registered: $($spec.Name) daily $($spec.At)"
}
