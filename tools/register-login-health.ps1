param(
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastLoginHealth'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('login-health.mjs')
$script = Join-Path $toolsDir 'login-health.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$script = (Resolve-Path -LiteralPath $script).Path
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw 'node not found.' }

$argsList = @($script, '--notify')

$hiddenActionHelper = Join-Path $PSScriptRoot 'ensure-run-hidden.ps1'
if (Test-Path -LiteralPath $hiddenActionHelper) {
  . $hiddenActionHelper
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument $argsList -WorkingDirectory $toolsDir
} else {
  $argument = '"{0}" --notify' -f $script
  $action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $toolsDir
}

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 2)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '全PC: ログイン切れ自動点検・通知（2時間ごと）' -Force | Out-Null
Write-Host "OK: task $taskName registered (every 2 hours)"
