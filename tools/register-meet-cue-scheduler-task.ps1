param([switch]$DryRun, [switch]$Ensure, [switch]$Remove)
$ErrorActionPreference = 'Stop'

$specs = @([pscustomobject]@{ TaskName = 'OrgiastMeetCueScheduler'; ScriptName = 'meet-cue-scheduler.mjs'; ScriptArgs = @() })
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @('tools\meet-cue-scheduler.mjs')
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
  $expectedArgs = '//nologo "{0}" "{1}" "{2}"' -f $hidden, $node, $scriptPath
  $matches = $current -and @($current.Actions).Count -eq 1 -and
    $current.Actions[0].Execute -ieq $wscript -and
    $current.Actions[0].Arguments -eq $expectedArgs -and
    $current.Actions[0].WorkingDirectory -eq $repo -and
    @($current.Triggers).Count -eq 1 -and
    $current.Triggers[0].Repetition.Interval -eq 'PT5M' -and
    $current.State -ne 'Disabled'
  if ($Ensure -and $matches) { Write-Host 'ok: OrgiastMeetCueScheduler already registered'; continue }
  if ($DryRun) { Write-Host "[DRY] $($spec.TaskName): $scriptPath every 5 minutes"; continue }
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument (@($scriptPath) + $spec.ScriptArgs) -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Check Google Calendar for Meet meetings with external attendees and launch Meet Cue Bot every 5 minutes' -Force | Out-Null
  $actual = Get-ScheduledTask -TaskName $spec.TaskName -ErrorAction Stop
  if ($actual.Actions[0].Arguments -ne $expectedArgs -or $actual.Triggers[0].Repetition.Interval -ne 'PT5M') { throw 'meet-cue-scheduler task read-back failed' }
  Write-Host 'ok: OrgiastMeetCueScheduler registered (every 5 min, synced main)'
}
