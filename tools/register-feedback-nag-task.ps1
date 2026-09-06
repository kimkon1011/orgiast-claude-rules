# Register the local feedback reminder at 09:00 every day.
# This file must remain ASCII-only for Windows PowerShell 5.1 compatibility.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $repo 'tools\feedback-nag.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$bootstrap = Join-Path $env:USERPROFILE '.claude\tools\nightly-bootstrap.ps1'
if (-not (Test-Path $bootstrap)) { throw "nightly bootstrap not found: $bootstrap" }
$action = New-HiddenScheduledTaskAction -Execute $powershell -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', 'tools\feedback-nag.mjs') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$taskName = 'OrgiastFeedbackNag'
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Send unresolved feedback by Discord DM every day at 09:00' -Force -ErrorAction Stop | Out-Null
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $registered) { throw "register failed: task '$taskName' does not exist after Register-ScheduledTask" }
Write-Host 'OK: task OrgiastFeedbackNag registered (daily at 09:00)'
$registered | Select-Object TaskName, State
