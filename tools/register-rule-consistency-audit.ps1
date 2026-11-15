param(
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastRuleConsistencyAudit'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('rule-consistency-audit.mjs')
$script = Join-Path $toolsDir 'rule-consistency-audit.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$script = (Resolve-Path -LiteralPath $script).Path
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw 'node not found.' }

$hiddenActionHelper = Join-Path $PSScriptRoot 'ensure-run-hidden.ps1'
if (Test-Path -LiteralPath $hiddenActionHelper) {
  . $hiddenActionHelper
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $toolsDir
} else {
  $argument = '"{0}"' -f $script
  $action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $toolsDir
}

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '05:40'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
try {
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'kim-PC: 組織指示・基本理念と配布ルールの矛盾週次再監査(月曜05:40)' -Force | Out-Null
} catch {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'kim-PC: 組織指示・基本理念と配布ルールの矛盾週次再監査(月曜05:40)' -Force | Out-Null
}
Write-Host "OK: task $taskName registered (weekly Monday 05:40)"
