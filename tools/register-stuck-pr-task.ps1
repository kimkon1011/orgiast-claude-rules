# Stalled own PR repair: kim-PC only, every three hours at :17.
param([switch]$ValidateOnly, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$name = 'OrgiastStuckPrSweeper'
if ($Unregister) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  exit 0
}
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\stuck-pr-sweeper.mjs')
$script = Join-Path $repo 'tools\stuck-pr-sweeper.mjs'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
if ($ValidateOnly) { & $node --check $script; if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }; return }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At '00:17' -RepetitionInterval (New-TimeSpan -Hours 3)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 170)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Repair stalled own PRs, at most two attempts per PR; decisions go to kim-inbox.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script) -or $task.Triggers.Repetition.Interval -ne 'PT3H') { throw "read-back failed: $name" }
Write-Host "OK: $name interval=PT3H"
