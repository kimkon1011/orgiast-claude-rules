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
