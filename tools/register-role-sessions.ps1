$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')

$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\auto-session.mjs')
$script = Join-Path $repo 'tools\auto-session.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 40)
$definitions = @(
  @{ Name = 'OrgiastRoleTester'; Role = 'tester'; Days = @('Monday', 'Thursday'); At = '04:10'; Description = 'Run tester role loop twice weekly' },
  @{ Name = 'OrgiastRoleReview'; Role = 'system-review'; Days = @('Sunday'); At = '04:30'; Description = 'Run system review role loop weekly' },
  @{ Name = 'OrgiastRoleCost'; Role = 'cost-check'; Days = @('Saturday'); At = '04:30'; Description = 'Run cost check role loop weekly' }
)

foreach ($definition in $definitions) {
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--role', $definition.Role, '--timeout-min', '30') -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $definition.Days -At $definition.At
  Register-ScheduledTask -TaskName $definition.Name -Action $action -Trigger $trigger -Settings $settings -Description $definition.Description -Force | Out-Null
  Write-Host "OK: task $($definition.Name) registered ($($definition.Days -join ',') $($definition.At))"
}

Get-ScheduledTask -TaskName 'OrgiastRoleTester', 'OrgiastRoleReview', 'OrgiastRoleCost' | Select-Object TaskName, State
