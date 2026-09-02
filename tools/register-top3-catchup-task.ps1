param(
  [switch]$Unregister
)

# 既存の register-*.ps1 と同じく、何度実行しても最新定義に置き換わる設計にする。
# 実行経路は nightly-bootstrap.ps1 経由にする: 起動のたびに ~/.claude/nightly-repo を
# origin/main へ同期してから tools\top3-catchup.mjs を走らせるので、ツールを改修しても
# このタスクを再登録する必要がない。終了コードは ~/.claude/logs/nightly-bootstrap-<日付>.log に残る。
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastTop3Catchup'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

# 稼働中の他タスク(OrgiastMorningBatch 等)と同じく ~/.claude/tools 配下の bootstrap を起点にする。
# リポ内の bootstrap は起動後に自己更新でコピーされるため、ここでは設置先を見る。
$bootstrap = Join-Path $HOME '.claude\tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) {
  $bootstrap = Join-Path $PSScriptRoot 'nightly-bootstrap.ps1'
}
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrap" }
$bootstrap = (Resolve-Path -LiteralPath $bootstrap).Path

$hiddenActionHelper = Join-Path $PSScriptRoot 'ensure-run-hidden.ps1'
$childArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', 'tools\top3-catchup.mjs')
if (Test-Path -LiteralPath $hiddenActionHelper) {
  . $hiddenActionHelper
  $action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument $childArguments -WorkingDirectory (Split-Path -Parent $bootstrap)
} else {
  $argument = ($childArguments | ForEach-Object { if ($_ -match '\s') { '"{0}"' -f $_ } else { $_ } }) -join ' '
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory (Split-Path -Parent $bootstrap)
  Write-Host 'NOTE: ensure-run-hidden.ps1 が無いため通常起動で登録しました（実行時にコンソール窓が出ます）'
}

# 毎日08:30から20:30まで、1時間おきに取りこぼしを確認する。
# 生成の定刻は 07:00/08:00 JST だが schedule は1〜3時間遅れるため、
# top3-catchup.mjs 側が 11時JST までは dispatch せず待つ(二重生成の防止)。
$trigger = New-ScheduledTaskTrigger -Daily -At '08:30'
$repetitionTemplate = New-ScheduledTaskTrigger -Once -At '08:30' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 12)
$trigger.Repetition = $repetitionTemplate.Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
# S4U は非 elevated 登録で Access Denied (0x80070005) になるため、対話ログオンの権限で実行する。
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '日次TOP3 の GitHub Actions 生成物を取りこぼした日に artifact から回収して秘書アプリへ投入する' -Force | Out-Null
Write-Host "OK: task $taskName registered (daily 08:30-20:30 hourly, limit 20 min)"
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$registered | Select-Object TaskName, State
$registered.Actions | Select-Object Execute, Arguments, WorkingDirectory
