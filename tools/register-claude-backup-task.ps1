param(
  [switch]$Unregister,
  [switch]$DryRun
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
if (-not $pwsh) {
  if ($DryRun) {
    Write-Host 'NOTE: pwsh が無いため、通常実行では winget による Microsoft.PowerShell の導入を試みる予定です（DryRun ではスキップ）'
  } else {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { $winget = Get-Command winget -ErrorAction SilentlyContinue }
    if ($winget) {
      Write-Host 'NOTE: pwsh が無いため winget で Microsoft.PowerShell の導入を試みます（最大300秒）'
      try {
        $installProcess = Start-Process -FilePath $winget.Source -ArgumentList @('install', '--id', 'Microsoft.PowerShell', '-e', '--accept-package-agreements', '--accept-source-agreements') -PassThru -NoNewWindow
        if (-not $installProcess.WaitForExit(300000)) {
          try { $installProcess.Kill() } catch {}
          Write-Warning 'pwsh の winget 導入が300秒でタイムアウトしました'
        } elseif ($installProcess.ExitCode -ne 0) {
          Write-Warning ('pwsh の winget 導入に失敗しました (exit={0})' -f $installProcess.ExitCode)
        }
      } catch { Write-Warning ('pwsh の winget 導入に失敗しました: {0}' -f $_.Exception.Message) }
      $installedPwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
      if (Test-Path -LiteralPath $installedPwsh) { $pwsh = $installedPwsh }
    } else { Write-Warning 'pwsh を導入できません: winget が見つかりません' }
  }
}
if (-not $pwsh) {
  $windowsPowerShell = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $windowsPowerShell)) { $windowsPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source }
  $pwsh = $windowsPowerShell
  Write-Host 'NOTE: pwsh が無いため Windows PowerShell 5.1 でタスクを登録します'
}

# hidden runner は別 PR で配布されるため、未導入の PC でもタスク登録自体は成功させる。
$hiddenActionHelper = Join-Path $PSScriptRoot 'ensure-run-hidden.ps1'
if (Test-Path -LiteralPath $hiddenActionHelper) {
  . $hiddenActionHelper
  $action = New-HiddenScheduledTaskAction -Execute $pwsh -ChildArgument @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) -WorkingDirectory $PSScriptRoot
} else {
  $argument = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $script
  $action = New-ScheduledTaskAction -Execute $pwsh -Argument $argument -WorkingDirectory $PSScriptRoot
  Write-Host 'NOTE: ensure-run-hidden.ps1 が無いため通常起動で登録しました（実行時にコンソール窓が出ます）'
}
Write-Host ('Execute: {0}' -f $pwsh)
Write-Host ('Arguments: -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $script)
if ($DryRun) { Write-Host 'OK: DryRun のためタスク登録をスキップしました'; exit 0 }
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
