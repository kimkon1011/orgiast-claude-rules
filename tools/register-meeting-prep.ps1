param([switch]$DryRun, [switch]$Ensure, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$map = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'fleet-pc-map.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($env:COMPUTERNAME -ine $map.'kim-PC'.hostname) { Write-Host 'skip: meeting-prep belongs to kim-PC'; exit 0 }
if (-not $Remove -and (Get-TimeZone).Id -ne 'Tokyo Standard Time') { throw 'meeting-prep requires Tokyo Standard Time for 07:00 JST' }
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @('tools\meeting-prep-dispatch.mjs', 'templates\meeting-prep-prompt.md', 'config\meeting-prep-routing.json')
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$scriptPath = Join-Path $repo 'tools\meeting-prep-dispatch.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$specs = @(
  [pscustomobject]@{ Name = 'OrgiastMeetingPrep'; Args = @('--live'); Collect = $false },
  [pscustomobject]@{ Name = 'OrgiastMeetingPrepCollect'; Args = @('--live', '--collect'); Collect = $true }
)
foreach ($spec in $specs) {
  $current = Get-ScheduledTask -TaskName $spec.Name -ErrorAction SilentlyContinue
  if ($Remove) {
    if ($current -and -not $DryRun) { Unregister-ScheduledTask -TaskName $spec.Name -Confirm:$false }
    continue
  }
  if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Merge and sync main first: missing $scriptPath" }
  $quotedArgs = ($spec.Args | ForEach-Object { '"{0}"' -f $_ }) -join ' '
  $expectedArgs = '//nologo "{0}" "{1}" "{2}" {3}' -f $hidden, $node, $scriptPath, $quotedArgs
  $scheduleMatches = $false
  if ($current -and @($current.Triggers).Count -eq 1) {
    $t = $current.Triggers[0]
    if ($spec.Collect) { $scheduleMatches = $t.Repetition.Interval -eq 'PT1H' -and ([datetime]$t.StartBoundary).Minute -eq 40 }
    else { $scheduleMatches = $t.DaysInterval -eq 1 -and ([datetime]$t.StartBoundary).Hour -eq 7 -and ([datetime]$t.StartBoundary).Minute -eq 0 }
  }
  $timeLimit = if ($spec.Collect) { 'PT30M' } else { 'PT0S' }
  if ($Ensure -and $current.Settings.ExecutionTimeLimit -eq $timeLimit -and $scheduleMatches -and $current.State -ne 'Disabled' -and @($current.Actions).Count -eq 1 -and $current.Actions[0].Execute -ieq $wscript -and $current.Actions[0].Arguments -eq $expectedArgs -and $current.Actions[0].WorkingDirectory -eq $repo) { Write-Host "ok: $($spec.Name) already registered"; continue }
  if ($DryRun) { Write-Host "[DRY] $($spec.Name): $expectedArgs (daily 07:00 / collect hourly :40 JST)"; continue }
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument (@($scriptPath) + $spec.Args) -WorkingDirectory $repo
  if ($spec.Collect) {
    $next = (Get-Date).Date.AddMinutes(40)
    while ($next -le (Get-Date)) { $next = $next.AddHours(1) }
    $trigger = New-ScheduledTaskTrigger -Once -At $next -RepetitionInterval (New-TimeSpan -Hours 1)
  } else { $trigger = New-ScheduledTaskTrigger -Daily -At '07:00' }
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit $(if ($spec.Collect) { New-TimeSpan -Minutes 30 } else { [TimeSpan]::Zero })
  Register-ScheduledTask -TaskName $spec.Name -Action $action -Trigger $trigger -Settings $settings -Description 'Prepare meetings with per-job 15-minute local fallback and collect results (JST)' -Force | Out-Null
  $actual = Get-ScheduledTask -TaskName $spec.Name -ErrorAction Stop
  if ($actual.Settings.ExecutionTimeLimit -ne $timeLimit -or $actual.Actions[0].Arguments -ne $expectedArgs -or $actual.Actions[0].WorkingDirectory -ne $repo -or ($spec.Collect -and $actual.Triggers[0].Repetition.Interval -ne 'PT1H') -or (-not $spec.Collect -and ([datetime]$actual.Triggers[0].StartBoundary).Hour -ne 7)) { throw 'meeting-prep task read-back failed' }
  Write-Host "ok: $($spec.Name) registered"
}
