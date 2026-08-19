# Plaud → tl;dv 自動インポートを 15 分ごとに実行するタスクを登録する。
# 実行: powershell -ExecutionPolicy Bypass -File "<このファイル>"
# 何度実行しても同じタスクを上書きするだけ（-Force）。他のタスクには触らない。

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $repo 'tools\plaud-to-tldv.mjs'
if (-not (Test-Path $script)) { throw "スクリプトが見つかりません: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node が見つかりません。Node.js を入れてから実行してください。' }

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName 'OrgiastPlaudToTldv' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Plaud の新しい録音を tl;dv へ自動インポート (15分毎)' -Force | Out-Null

Write-Host 'OK: タスク OrgiastPlaudToTldv を登録しました（15分ごとに実行）'
Get-ScheduledTask -TaskName 'OrgiastPlaudToTldv' | Select-Object TaskName, State
