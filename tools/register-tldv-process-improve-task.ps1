# tl;dv 会議 -> 制作プロセス改善 夜間ループタスクを登録する。
# 実行: powershell -ExecutionPolicy Bypass -File "<kono file>"
#
# NOTE: kono file wa BOM tsuki UTF-8 de hozon suru koto. Windows PowerShell 5.1 wa
# BOM nashi UTF-8 wo Shift-JIS to gokai shi, nihongo ga aru to parse error ni naru.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\tldv-process-improve.mjs')
$script = Join-Path $repo 'tools\tldv-process-improve.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

# Console window 対策: run-hidden.vbs 経由で起動
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '01:40' -RandomDelay (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 60)

Register-ScheduledTask -TaskName 'OrgiastTldvProcessImprove' -Action $action -Trigger $trigger -Settings $settings -Description 'Extract process improvements from tl;dv meetings daily at 01:40 (random delay up to 5 minutes)' -Force | Out-Null

Write-Host 'OK: task OrgiastTldvProcessImprove registered (daily at 01:40, random delay up to 5 minutes)'
Get-ScheduledTask -TaskName 'OrgiastTldvProcessImprove' | Select-Object TaskName, State
