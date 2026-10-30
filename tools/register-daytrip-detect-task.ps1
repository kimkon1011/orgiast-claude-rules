param([switch]$DryRun, [switch]$Ensure, [switch]$Remove)
$ErrorActionPreference = 'Stop'
# Only the machine hosting kim's LINE receiver owns this personal calendar job.
# Other fleet PCs must never ingest colleagues' notifications into kim's calendar.
if (-not $Remove -and -not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE 'Downloads\claude-mobile\app\api\line-ingest\route.ts'))) {
  Write-Host 'skip: daytrip-detect belongs to the LINE receiver host'
  exit 0
}
$specs = @([pscustomobject]@{ TaskName = 'OrgiastDaytripDetect'; ScriptName = 'daytrip-detect.mjs'; ScriptArgs = @() })
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# Keep the synced repo as the fallback too: never run a development copy.
# The script existence check below fails closed until main has been synced.
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @('tools\daytrip-detect.mjs')
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
    $current.Triggers[0].DaysInterval -eq 1 -and
    $current.Triggers[0].StartBoundary.Substring(11, 5) -eq '20:00' -and
    $current.State -ne 'Disabled'
  if ($Ensure -and $matches) { Write-Host 'ok: OrgiastDaytripDetect already registered'; continue }
  if ($DryRun) { Write-Host "[DRY] $($spec.TaskName): $scriptPath daily at 20:00"; continue }
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument (@($scriptPath) + $spec.ScriptArgs) -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Daily -At '20:00'
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 55)
  Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Detect day trip candidates and process kim replies daily at 20:00' -Force | Out-Null
  $actual = Get-ScheduledTask -TaskName $spec.TaskName -ErrorAction Stop
  if ($actual.Actions[0].Arguments -ne $expectedArgs -or $actual.Triggers[0].DaysInterval -ne 1 -or $actual.Triggers[0].StartBoundary.Substring(11, 5) -ne '20:00') { throw 'daytrip-detect task read-back failed' }
  Write-Host 'ok: OrgiastDaytripDetect registered (daily 20:00, synced main)'
}
