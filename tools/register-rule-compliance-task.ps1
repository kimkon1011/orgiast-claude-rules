param(
  [switch]$Unregister
)

# 既存の register-*.ps1 と同じく、何度実行しても最新定義に置き換わる設計にする。
# rule-compliance-loop.mjs は「手動 --apply のみ」で定期実行の口が無かった
# (project_rule_compliance_loop.md の「未配線: 定期実行」)。このタスクがその口を作る。
$ErrorActionPreference = 'Stop'
$taskName = 'ClaudeRuleComplianceAudit'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

$script = Join-Path $PSScriptRoot 'run-rule-compliance-loop.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$script = (Resolve-Path -LiteralPath $script).Path
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw 'node not found.' }

$hiddenActionHelper = Join-Path $PSScriptRoot 'ensure-run-hidden.ps1'
if (Test-Path -LiteralPath $hiddenActionHelper) {
  . $hiddenActionHelper
  $action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--days', '7') -WorkingDirectory $PSScriptRoot
} else {
  $argument = '"{0}" --days 7' -f $script
  $action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $PSScriptRoot
  Write-Host 'NOTE: ensure-run-hidden.ps1 が無いため通常起動で登録しました（実行時にコンソール窓が出ます）'
}
# ローカルの ~/.claude/projects/*.jsonl だけを読む純ローカル処理なので、対話ログオン不要で回せる。
$trigger = New-ScheduledTaskTrigger -Daily -At '03:50'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'ルール遵守監査ループを毎日実行し rule-compliance.md / rule-compliance-state.json を更新' -Force | Out-Null
Write-Host "OK: task $taskName registered (daily 03:50, limit 30 min)"
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$registered | Select-Object TaskName, State
$registered.Actions | Select-Object Execute, Arguments, WorkingDirectory
