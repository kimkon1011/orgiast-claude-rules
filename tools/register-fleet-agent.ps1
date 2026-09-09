# Orgiast fleet agent を15分ごとに起動する。Windows PowerShell 5.1向けUTF-8 BOM。
# 実行対象(fleet-agent.mjs)は作業ツリーではなく nightly-bootstrap が origin/main へ同期した
# チェックアウト(~/.claude/nightly-repo)から実行する(2026-09-10・nightly-batch と同様の分離)。
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastFleetAgent'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$target = 'tools\fleet-agent.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "fleet-agent.mjs not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target, '--once') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$repetition = New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 24)
$trigger.Repetition = $repetition.Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 35)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '中央fleet指示を15分ごとに確認し、許可された処理だけを実行する' -Force | Out-Null
} catch {
  if ($_.Exception.Message -match 'Access is denied|Access Denied|0x80070005|アクセスが拒否') {
    throw "Access Denied: 現在のユーザーでタスクを再登録できません。既存の $taskName を同じユーザーで削除してから再実行してください。"
  }
  throw
}
Write-Host "OK: task $taskName registered (every 15 minutes, limit 35 min)"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
