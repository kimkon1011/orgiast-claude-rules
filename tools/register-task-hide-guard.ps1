$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = if ($env:ORGIAST_NIGHTLY_REPO) { $env:ORGIAST_NIGHTLY_REPO } else { Join-Path $env:USERPROFILE '.claude\nightly-repo' }
$previousRepo = $env:ORGIAST_NIGHTLY_REPO
try {
  $env:ORGIAST_NIGHTLY_REPO = $repo
  $tools = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('task-hide-guard.ps1')
} finally { $env:ORGIAST_NIGHTLY_REPO = $previousRepo }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = try { New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited } catch { $null }
$logon = try { New-ScheduledTaskTrigger -AtLogOn -User $user } catch { New-ScheduledTaskTrigger -AtLogOn }
$logon.Delay = 'PT1M'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'task-hide-guard.ps1'))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
if ($principal) {
  try {
    Register-ScheduledTask -TaskName 'Claude-TaskHideGuard' -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null
  } catch {
    Register-ScheduledTask -TaskName 'Claude-TaskHideGuard' -Action $action -Trigger @($logon, $repeat) -Settings $settings -Force | Out-Null
  }
} else {
  Register-ScheduledTask -TaskName 'Claude-TaskHideGuard' -Action $action -Trigger @($logon, $repeat) -Settings $settings -Force | Out-Null
}
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tools 'window-spawn-watch.ps1'))
$logon = try { New-ScheduledTaskTrigger -AtLogOn -User $user } catch { New-ScheduledTaskTrigger -AtLogOn }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
if ($principal) {
  try {
    Register-ScheduledTask -TaskName 'OrgiastWindowSpawnWatch' -Action $action -Trigger $logon -Settings $settings -Principal $principal -Force | Out-Null
  } catch {
    Register-ScheduledTask -TaskName 'OrgiastWindowSpawnWatch' -Action $action -Trigger $logon -Settings $settings -Force | Out-Null
  }
} else {
  Register-ScheduledTask -TaskName 'OrgiastWindowSpawnWatch' -Action $action -Trigger $logon -Settings $settings -Force | Out-Null
}
Start-ScheduledTask -TaskName 'Claude-TaskHideGuard'
# Existing manually installed tasks also need migration. Do not mark the
# install fallback complete: converge must retry after nightly-repo is updated.
# Compare normalized paths: the resolver expands 8.3 segments (GetFullPath), $repo does not.
if ((Normalize-RepoRoot $tools) -eq (Normalize-RepoRoot (Join-Path $repo 'tools'))) {
  Set-Content -LiteralPath (Join-Path $env:USERPROFILE '.claude\.task-hide-guard-v1') -Value '1' -Encoding ASCII
}
Write-Output 'OK: Claude-TaskHideGuard and OrgiastWindowSpawnWatch registered'
