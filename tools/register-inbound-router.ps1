param([switch]$DryRun, [string]$RepoRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = if ($RepoRoot) { [IO.Path]::GetFullPath($RepoRoot) } else { Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\inbound-router.mjs', 'config\inbound-router.json') }
$script = Join-Path $repo 'tools\inbound-router.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "inbound-router not found: $script" }
if ($DryRun) { Write-Host "[DRY] OrgiastInboundRouter: $script every 15 minutes"; exit 0 }
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--runner-log') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -Priority 4
Register-ScheduledTask -TaskName 'OrgiastInboundRouter' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
$actual = Get-ScheduledTask -TaskName 'OrgiastInboundRouter'
if ($actual.Actions[0].Arguments -ne $action.Arguments -or $actual.Triggers[0].Repetition.Interval -ne 'PT15M' -or $actual.Settings.ExecutionTimeLimit -ne 'PT14M' -or $actual.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'inbound-router task read-back failed' }
Write-Host 'ok: OrgiastInboundRouter registered (15 minutes, hidden runner, IgnoreNew)'
