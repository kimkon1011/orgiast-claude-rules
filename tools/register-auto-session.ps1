# Orgiast auto-session runner を毎日 03:20 に起動する。
# Windows PowerShell 5.1 で日本語を安全に扱うため UTF-8 BOM で保存する。
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $repo 'tools\auto-session.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$argument = '"{0}"' -f $script
$action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '03:20'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6)

Register-ScheduledTask -TaskName 'OrgiastAutoSession' -Action $action -Trigger $trigger -Settings $settings -Description 'Run one unattended Orgiast TODO session daily at 03:20' -Force | Out-Null

Write-Host 'OK: task OrgiastAutoSession registered (daily 03:20)'
Get-ScheduledTask -TaskName 'OrgiastAutoSession' | Select-Object TaskName, State
