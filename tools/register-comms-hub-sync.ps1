param([switch]$DryRun, [switch]$Ensure, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$keyPath = if ($env:GOOGLE_SA_KEY) { $env:GOOGLE_SA_KEY } else { Join-Path $env:USERPROFILE 'Downloads\CLAUDE.md配布\aujust-sales-automation\.gcp\sheets-sa.json' }
if (-not $Remove -and -not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
  Write-Host 'ok: skip comms-hub (no local DWD key)'
  exit 0
}
$specs = @([pscustomobject]@{ TaskName = 'OrgiastCommsHubSync'; ScriptName = 'comms-hub-sync.mjs'; ScriptArgs = @('--live') })
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# Keep the synced repo as the fallback too: never run a development copy.
# The script existence check below fails closed until main has been synced.
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @('tools\comms-hub-sync.mjs')
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
foreach ($spec in $specs) {
  $current = Get-ScheduledTask -TaskName $spec.TaskName -ErrorAction SilentlyContinue
  if ($Remove) {
    if ($current -and -not $DryRun) { Unregister-ScheduledTask -TaskName $spec.TaskName -Confirm:$false }
    continue
  }
  $scriptPath = Join-Path $repo (Join-Path 'tools' $spec.ScriptName)
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Merge and sync main first: missing $scriptPath" }
  $node = (Get-Command node -ErrorAction Stop).Source
  $hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $expectedArgs = '//nologo "{0}" "{1}" "{2}" "--live"' -f $hidden, $node, $scriptPath
  $matches = $current -and @($current.Actions).Count -eq 1 -and
    $current.Actions[0].Execute -ieq $wscript -and
    $current.Actions[0].Arguments -eq $expectedArgs -and
    $current.Actions[0].WorkingDirectory -eq $repo -and
    @($current.Triggers).Count -eq 1 -and
    $current.Triggers[0].Repetition.Interval -eq 'PT1H' -and
    ([datetime]$current.Triggers[0].StartBoundary).Minute -eq 15 -and
    $current.State -ne 'Disabled'
  if ($Ensure -and $matches) { Write-Host 'ok: OrgiastCommsHubSync already registered'; continue }
  if ($DryRun) { Write-Host "[DRY] $($spec.TaskName): $scriptPath hourly at :15"; continue }
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument (@($scriptPath) + $spec.ScriptArgs) -WorkingDirectory $repo
  $next = (Get-Date).Date.AddHours((Get-Date).Hour).AddMinutes(15)
  if ($next -le (Get-Date)) { $next = $next.AddHours(1) }
  $trigger = New-ScheduledTaskTrigger -Once -At $next -RepetitionInterval (New-TimeSpan -Hours 1)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Sync business communications to Drive cases hub hourly at :15' -Force | Out-Null
  $actual = Get-ScheduledTask -TaskName $spec.TaskName -ErrorAction Stop
  if ($actual.Actions[0].Arguments -ne $expectedArgs -or $actual.Triggers[0].Repetition.Interval -ne 'PT1H') { throw 'comms-hub task read-back failed' }
  Write-Host 'ok: OrgiastCommsHubSync registered (hourly :15, synced main)'
}
