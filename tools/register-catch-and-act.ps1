param([switch]$DryRun, [string]$RepoRoot, [ValidateSet('cursor', 'llm-ask')][string]$Classifier = 'llm-ask')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$repo = if ($RepoRoot) { [IO.Path]::GetFullPath($RepoRoot) } else { Get-SyncedRepoRoot }
$script = Join-Path $repo 'tools\catch-and-act.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Merge and sync main first, or specify -RepoRoot for verification: $script" }
if ($DryRun) { Write-Host "[DRY] OrgiastCatchAndAct: $script every 15 minutes ($Classifier)"; exit 0 }
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--classifier', $Classifier) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -Priority 4
Register-ScheduledTask -TaskName 'OrgiastCatchAndAct' -Action $action -Trigger $trigger -Settings $settings -Description 'Catch LINE/email, update calendar, queue drafts and deadline approvals every 15 minutes' -Force | Out-Null
$actual = Get-ScheduledTask -TaskName 'OrgiastCatchAndAct' -ErrorAction Stop
if ($actual.Actions[0].Arguments -ne $action.Arguments -or $actual.Triggers[0].Repetition.Interval -ne 'PT15M' -or $actual.Settings.ExecutionTimeLimit -ne 'PT14M') { throw 'catch-and-act task read-back failed' }
Write-Host 'ok: OrgiastCatchAndAct registered (15 minutes, hidden runner, IgnoreNew)'
