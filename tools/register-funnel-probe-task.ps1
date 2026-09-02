param(
  [switch]$Unregister
)

# 既存の register-*.ps1 と同じく、何度実行しても最新定義に置き換わる設計にする。
# 実行経路は nightly-bootstrap.ps1 経由にする: 起動のたびに ~/.claude/nightly-repo を
# origin/main へ同期してから tools\funnel-probe.mjs を走らせるので、改修しても再登録が要らない。
#
# 何のためのタスクか: 2026-08-29〜09-01 に Funnel の DNS が4日間引けず日次TOP3 が
# 一度も届かなかったが、事後に追える記録が一切残っておらず真因を確定できなかった
# (PC は起きていた・ノードキーも有効・serve 設定も永続していた)。次に起きた時に
# 確定できるよう、到達性を毎時 JSONL へ残す。
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastFunnelProbe'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

$bootstrap = Join-Path $HOME '.claude\tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) {
  $bootstrap = Join-Path $PSScriptRoot 'nightly-bootstrap.ps1'
}
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrap" }
$bootstrap = (Resolve-Path -LiteralPath $bootstrap).Path

$hiddenActionHelper = Join-Path $PSScriptRoot 'ensure-run-hidden.ps1'
$childArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', 'tools\funnel-probe.mjs')
if (Test-Path -LiteralPath $hiddenActionHelper) {
  . $hiddenActionHelper
  $action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument $childArguments -WorkingDirectory (Split-Path -Parent $bootstrap)
} else {
  $argument = ($childArguments | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory (Split-Path -Parent $bootstrap)
  Write-Host 'NOTE: ensure-run-hidden.ps1 が無いため通常起動で登録しました（実行時にコンソール窓が出ます）'
}

# 障害がいつ始まりいつ終わったかを後から言えるよう、時間帯を絞らず1日中1時間おきに測る。
$trigger = New-ScheduledTaskTrigger -Daily -At '00:05'
$repetitionTemplate = New-ScheduledTaskTrigger -Once -At '00:05' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 24)
$trigger.Repetition = $repetitionTemplate.Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
# S4U は非 elevated 登録で Access Denied (0x80070005) になるため、対話ログオンの権限で実行する。
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Tailscale Funnel の到達性(DNS/HTTPS/ローカル)を毎時 ~/.claude/logs/funnel-probe.jsonl へ記録する' -Force | Out-Null
Write-Host "OK: task $taskName registered (hourly, 24h, limit 5 min)"
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$registered | Select-Object TaskName, State
$registered.Actions | Select-Object Execute, Arguments, WorkingDirectory
