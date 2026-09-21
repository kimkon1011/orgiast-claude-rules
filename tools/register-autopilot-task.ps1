# Run only after kim approves registration. UTF-8 without BOM (ASCII script).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')

$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\autopilot-run.mjs', 'skills\autopilot\SKILL.md')
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $repo 'tools\autopilot-run.mjs'
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 29)
Register-ScheduledTask -TaskName 'OrgiastAutopilot' -Action $action -Trigger $trigger -Settings $settings -Description 'Autopilot: one supervised iteration every 30 minutes' -Force | Out-Null
Write-Host 'OK: OrgiastAutopilot registered (every 30 minutes)'
