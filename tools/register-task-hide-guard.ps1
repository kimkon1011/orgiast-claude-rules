$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$repo = if ($env:ORGIAST_NIGHTLY_REPO) { $env:ORGIAST_NIGHTLY_REPO } else { Join-Path $env:USERPROFILE '.claude\nightly-repo' }
$tools = Join-Path $repo 'tools'
if (-not (Test-Path -LiteralPath (Join-Path $tools 'task-hide-guard.ps1'))) { $tools = $PSScriptRoot }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT1M'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'task-hide-guard.ps1'))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'Claude-TaskHideGuard' -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'window-spawn-watch.ps1'))
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName 'OrgiastWindowSpawnWatch' -Action $action -Trigger $logon -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Claude-TaskHideGuard'
# Existing manually installed tasks also need migration. Do not mark the
# install fallback complete: converge must retry after nightly-repo is updated.
if ($tools -eq (Join-Path $repo 'tools')) {
  Set-Content -LiteralPath (Join-Path $env:USERPROFILE '.claude\.task-hide-guard-v1') -Value '1' -Encoding ASCII
}
Write-Output 'OK: Claude-TaskHideGuard and OrgiastWindowSpawnWatch registered'
