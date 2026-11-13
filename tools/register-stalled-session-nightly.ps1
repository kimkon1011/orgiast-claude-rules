$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\nightly-bootstrap.ps1', 'tools\stalled-session-resume.mjs')
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
$sweepScript = Join-Path $repo 'tools\stalled-session-resume.mjs'
& $node --check $sweepScript
if ($LASTEXITCODE -ne 0) { throw "node --check failed: $sweepScript" }
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$installed = Join-Path $env:USERPROFILE '.claude\tools'
New-Item -ItemType Directory -Force -Path $installed | Out-Null
$nb = Join-Path $installed 'nightly-bootstrap.ps1'
Copy-Item -LiteralPath (Join-Path $repo 'tools\nightly-bootstrap.ps1') -Destination $nb -Force
$act = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $nb, '-Target', 'tools\nightly-batch.ps1') -WorkingDirectory $repo
$trg = New-ScheduledTaskTrigger -Daily -At 3:00am -RandomDelay (New-TimeSpan -Minutes 2)
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 5)
Register-ScheduledTask -TaskName 'OrgiastNightlyBatch' -Action $act -Trigger $trg -Settings $set -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastNightlyBatch'
if (-not ($task.Actions.Arguments -match 'nightly-bootstrap')) { throw 'Nightly action verification failed' }

$sweepAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($sweepScript) -WorkingDirectory $repo
$sweepTrigger = New-ScheduledTaskTrigger -Daily -At 3:05am -RandomDelay (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'OrgiastStalledSessionSweep' -Action $sweepAction -Trigger $sweepTrigger -Settings $set -Force | Out-Null
$sweep = Get-ScheduledTask -TaskName 'OrgiastStalledSessionSweep'
if (-not ($sweep.Actions.Arguments -match 'stalled-session-resume')) { throw 'Stalled session sweep action verification failed' }

$waitAction = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($sweepScript, '--overdue') -WorkingDirectory $repo
$waitTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$waitSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'OrgiastWaitDeadlineResume' -Action $waitAction -Trigger $waitTrigger -Settings $waitSettings -Force | Out-Null
$waitTask = Get-ScheduledTask -TaskName 'OrgiastWaitDeadlineResume'
if ($waitTask.Actions.Count -ne 1 -or $waitTask.Actions.Execute -ne $waitAction.Execute -or $waitTask.Actions.Arguments -ne $waitAction.Arguments -or $waitTask.Actions.WorkingDirectory -ne $waitAction.WorkingDirectory) { throw 'Wait deadline action verification failed' }
if ($waitTask.Triggers.Count -ne 1 -or $waitTask.Triggers[0].Repetition.Interval -ne 'PT15M' -or [Math]::Abs(([DateTime]$waitTask.Triggers[0].StartBoundary - [DateTime]$waitTrigger.StartBoundary).TotalSeconds) -gt 2) { throw 'Wait deadline trigger verification failed' }
if ($waitTask.Settings.MultipleInstances -ne 'IgnoreNew' -or $waitTask.Settings.ExecutionTimeLimit -ne 'PT2H' -or -not $waitTask.Settings.StartWhenAvailable -or $waitTask.Settings.DisallowStartIfOnBatteries -or $waitTask.Settings.StopIfGoingOnBatteries) { throw 'Wait deadline settings verification failed' }
