# Orgiast fleet agent を2分ごとに起動する。Windows PowerShell 5.1向けUTF-8 BOM。
# 実行対象(fleet-mail.mjs)は作業ツリーではなく nightly-bootstrap が origin/main へ同期した
# チェックアウト(~/.claude/nightly-repo)から実行する(2026-09-10・nightly-batch と同様の分離)。
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastFleetMail'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  $watchdogExisting = Get-ScheduledTask -TaskName 'OrgiastFleetMailWatchdog' -ErrorAction SilentlyContinue
  if ($watchdogExisting) { Unregister-ScheduledTask -TaskName 'OrgiastFleetMailWatchdog' -Confirm:$false; Write-Host 'OK: task OrgiastFleetMailWatchdog unregistered' }
  exit 0
}

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\fleet-mail.mjs', 'tools\nightly-bootstrap.ps1')
$target = 'tools\fleet-mail.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "fleet-mail.mjs not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target, '--poll') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$repetition = New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Hours 24)
$trigger.Repetition = $repetition.Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 40)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'PC間メッセージを2分ごとに受信し、promptは既存opt-in時だけ回答する' -Force | Out-Null
} catch {
  if ($_.Exception.Message -match 'Access is denied|Access Denied|0x80070005|アクセスが拒否') {
    throw "Access Denied: 現在のユーザーでタスクを再登録できません。既存の $taskName を同じユーザーで削除してから再実行してください。"
  }
  throw
}
Write-Host "OK: task $taskName registered (every 2 minutes, limit 40 min)"

# 中央の未配達ウォッチドッグ（kim-PC 専用）: fleet-sheet.env に FLEET_MAIL_WATCHDOG=1 があるときだけ
# 毎時タスク OrgiastFleetMailWatchdog を一緒に登録する。status=new が30分以上残ったメッセージを
# Discord #claude-code と kim DM へ報告する（2026-10-10 事故: 返信4通が受信停止に気付かれなかった）。
$watchdogEnabled = $false
try {
  $fleetEnv = Join-Path $env:USERPROFILE '.claude\fleet-sheet.env'
  if (Test-Path -LiteralPath $fleetEnv -PathType Leaf) {
    $watchdogEnabled = [bool](Select-String -LiteralPath $fleetEnv -Pattern '^\s*FLEET_MAIL_WATCHDOG=1' -Quiet)
  }
} catch {}
if ($watchdogEnabled) {
  $watchdogTask = 'OrgiastFleetMailWatchdog'
  $watchdogTarget = 'tools\fleet-mail-watchdog.mjs'
  $watchdogScript = Join-Path $repo $watchdogTarget
  if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "fleet-mail-watchdog.mjs not found: $watchdogScript" }
  $watchdogAction = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $watchdogTarget) -WorkingDirectory $repo
  $watchdogTrigger = New-ScheduledTaskTrigger -Daily -At '00:05'
  $watchdogRepetition = New-ScheduledTaskTrigger -Once -At '00:05' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 24)
  $watchdogTrigger.Repetition = $watchdogRepetition.Repetition
  $watchdogSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
  Register-ScheduledTask -TaskName $watchdogTask -Action $watchdogAction -Trigger $watchdogTrigger -Settings $watchdogSettings -Principal $principal -Description 'fleet-mail の未配達メッセージを毎時監視し Discord #claude-code と kim DM へ通知する' -Force | Out-Null
  Write-Host "OK: task $watchdogTask registered (every hour, limit 20 min)"
}
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
