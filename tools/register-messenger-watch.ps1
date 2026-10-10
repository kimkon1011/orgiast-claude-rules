# Orgiast Messenger 未読監視 を30分ごと(7:00〜23:00)に起動する。Windows PowerShell 5.1向けUTF-8 BOM。
# 実行対象(messenger-watch.mjs)は作業ツリーではなく nightly-bootstrap が origin/main へ同期した
# チェックアウト(~/.claude/nightly-repo)から実行する(2026-09-10・nightly-batch と同様の分離)。
# 読み取り専用の監視。夜間(23:00〜7:00)は動かさない。
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastMessengerWatch'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\messenger-watch.mjs', 'tools\nightly-bootstrap.ps1')
$target = 'tools\messenger-watch.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "messenger-watch.mjs not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target) -WorkingDirectory $repo
# 7:00 から 16 時間(=23:00 まで) 30 分ごと。0〜5 分のランダム遅延でアクセスを分散する。
$trigger = New-ScheduledTaskTrigger -Daily -At '07:00'
$repetition = New-ScheduledTaskTrigger -Once -At '07:00' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 16) -RandomDelay (New-TimeSpan -Minutes 5)
$trigger.Repetition = $repetition.Repetition
$trigger.RandomDelay = $repetition.RandomDelay
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 9) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Messengerの未読を30分ごと(7:00〜23:00)に読み取り、新着をkimへDM通知する' -Force | Out-Null
} catch {
  if ($_.Exception.Message -match 'Access is denied|Access Denied|0x80070005|アクセスが拒否') {
    throw "Access Denied: 現在のユーザーでタスクを再登録できません。既存の $taskName を同じユーザーで削除してから再実行してください。"
  }
  throw
}
Write-Host "OK: task $taskName registered (every 30 minutes 07:00-23:00, random delay up to 5 min, limit 9 min)"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
