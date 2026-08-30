# Orgiast auto-session runner を毎日 00:30 に起動する。
# Windows PowerShell 5.1 で日本語を安全に扱うため UTF-8 BOM で保存する。
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$fixedLauncher = Join-Path $env:USERPROFILE '.claude\auto-session-repo\tools\auto-session-launcher.mjs'
$repoLauncher = Join-Path $repo 'tools\auto-session-launcher.mjs'
$script = if (Test-Path $fixedLauncher) { $fixedLauncher } else { $repoLauncher }
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$argument = '"{0}" --count all --timeout-min 35 --deadline 07:30' -f $script
$action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '00:30'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask -TaskName 'OrgiastAutoSession' -Action $action -Trigger $trigger -Settings $settings -Description '残TODOを全件実行（00:30開始・07:30締切・1件35分）' -Force | Out-Null

Write-Host 'OK: task OrgiastAutoSession registered (daily 00:30, deadline 07:30)'
Get-ScheduledTask -TaskName 'OrgiastAutoSession' | Select-Object TaskName, State
