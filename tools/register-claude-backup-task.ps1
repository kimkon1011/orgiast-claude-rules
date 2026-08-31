param(
  [switch]$Unregister
)

# 既存の register-*.ps1 と同じく、何度実行しても最新定義に置き換わる設計にする。
$ErrorActionPreference = 'Stop'
$taskName = 'ClaudeDailyDriveBackup'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

$script = Join-Path $PSScriptRoot 'backup-claude-to-drive.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$script = (Resolve-Path -LiteralPath $script).Path
$pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
if (-not $pwsh) { throw 'pwsh not found. PowerShell 7 をインストールしてください。' }

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute $pwsh -ChildArgument @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At '03:40'
# 夜間にスリープしていても次回起動時に回収し、バッテリー移行でも途中停止させない。
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
# Google Drive の仮想ドライブは Drive アプリが動く対話ログオン中だけ存在するため、対話セッションに限定する。
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Claude Code 環境を Google Drive へ毎日検証付きでバックアップ' -Force | Out-Null
Write-Host "OK: task $taskName registered (daily 03:40, limit 2 hours)"
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$registered | Select-Object TaskName, State
$registered.Actions | Select-Object Execute, Arguments, WorkingDirectory
