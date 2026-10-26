# Register the SGA (hanbai-kanrihi) autopilot tasks. ASCII only for Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\sga-autopilot.mjs')
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$bootstrap = Join-Path $env:USERPROFILE '.claude\tools\nightly-bootstrap.ps1'
if (-not (Test-Path $bootstrap)) { throw $bootstrap }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
$jobs = @(
    @{ Name = 'OrgiastSgaDmWatch'; Command = 'watch-dm'; Description = 'SGA autopilot: watch kim DM every 10 min'; Trigger = (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 10)) },
    @{ Name = 'OrgiastSgaDailySync'; Command = 'sync'; Description = 'SGA autopilot: sync accounting data daily'; Trigger = (New-ScheduledTaskTrigger -Daily -At '05:40') },
    @{ Name = 'OrgiastSgaWeekly'; Command = 'weekly'; Description = 'SGA autopilot: send weekly expense report'; Trigger = (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '08:30') },
    @{ Name = 'OrgiastSgaMeetingMemo'; Command = 'meeting-memo'; Description = 'SGA autopilot: prepare monthly meeting memo'; Trigger = (New-ScheduledTaskTrigger -Daily -At '07:00') }
)
foreach ($job in $jobs) {
    $childArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', 'tools\sga-autopilot.mjs', '-Shell', 'powershell', $job.Command)
    if ($job.Command -eq 'meeting-memo') { $childArgs += '--scheduled' }
    $action = New-HiddenScheduledTaskAction -Execute $powershell -ChildArgument $childArgs -WorkingDirectory $repo
    Register-ScheduledTask -TaskName $job.Name -Description $job.Description -Action $action -Trigger $job.Trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
    $registered = Get-ScheduledTask -TaskName $job.Name -ErrorAction Stop
    $registered | Select-Object TaskName, State
}
Write-Host 'OK: 4 SGA autopilot tasks registered'
