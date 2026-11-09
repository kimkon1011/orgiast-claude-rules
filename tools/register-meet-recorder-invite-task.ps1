param([switch]$DryRun, [switch]$Ensure, [switch]$Remove)
$ErrorActionPreference = 'Stop'
# Only the machine hosting kim's LINE receiver owns this personal calendar job.
# Other fleet PCs must never modify kim's calendar events.
if (-not $Remove -and -not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE 'Downloads\claude-mobile\app\api\line-ingest\route.ts'))) {
  Write-Host 'skip: meet-recorder-invite belongs to the LINE receiver host'
  exit 0
}
$specs = @([pscustomobject]@{ TaskName = 'OrgiastMeetRecorderInvite'; ScriptName = 'meet-recorder-invite.mjs'; ScriptArgs = @() })
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# Keep the synced repo as the fallback too: never run a development copy.
# The script existence check below fails closed until main has been synced.
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @('tools\meet-recorder-invite.mjs')
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
    $current.Triggers[0].Repetition.Interval -eq 'PT30M' -and
    $current.State -ne 'Disabled'
  if ($Ensure -and $matches) { Write-Host 'ok: OrgiastMeetRecorderInvite already registered'; continue }
  if ($DryRun) { Write-Host "[DRY] $($spec.TaskName): $scriptPath every 30 minutes"; continue }
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument (@($scriptPath) + $spec.ScriptArgs) -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Minutes 30)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Invite seisaku-team to kim Meet events for tl;dv recording every 30 minutes' -Force | Out-Null
  $actual = Get-ScheduledTask -TaskName $spec.TaskName -ErrorAction Stop
  if ($actual.Actions[0].Arguments -ne $expectedArgs -or $actual.Triggers[0].Repetition.Interval -ne 'PT30M') { throw 'meet-recorder-invite task read-back failed' }
  Write-Host 'ok: OrgiastMeetRecorderInvite registered (every 30 min, synced main)'
}