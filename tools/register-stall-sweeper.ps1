# 日次停滞スイーパー。既存タスクは更新し、削除しない。
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\stall-sweeper.mjs', 'tools\codex-do.mjs', 'tools\notify-kim.mjs')
$script = Join-Path $repo 'tools\stall-sweeper.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "実行ファイルがありません: $script" }
if ($ValidateOnly) {
  & node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'Node構文検証に失敗しました' }
  Write-Host ('検証のみ完了（登録なし）: ' + $script + ' / 毎日04:10')
  return
}
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--apply') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '04:10'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName 'OrgiastStallSweeper' -Action $action -Trigger $trigger -Settings $settings -Description '停滞作業を最大5件再開。Claude不使用・自動マージなし。毎日04:10。' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastStallSweeper' -ErrorAction Stop
if ($task.Actions.Arguments -notlike '*stall-sweeper.mjs*' -or $task.Triggers.StartBoundary -notmatch 'T04:10:00') { throw '登録後の読戻し検証に失敗しました' }
& schtasks.exe /query /tn OrgiastStallSweeper
if ($LASTEXITCODE -ne 0) { throw 'schtasksによる登録確認に失敗しました' }
Write-Host '登録・読戻し確認済み: OrgiastStallSweeper / 毎日04:10'
