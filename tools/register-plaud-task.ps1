# Plaud -> tl;dv jidou import wo maiban 3:00 ni 1 kai jikkou suru task wo touroku suru.
# Jikkou: powershell -ExecutionPolicy Bypass -File "<kono file>"
# Nando jikkou shitemo onaji task wo uwagaki suru dake (-Force). Hoka no task ni wa furenai.
#
# NOTE: kono file wa BOM tsuki UTF-8 de hozon suru koto. Windows PowerShell 5.1 wa
# BOM nashi UTF-8 wo Shift-JIS to gokai shi, nihongo ga aru to parse error ni naru.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $repo 'tools\plaud-to-tldv.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

# 1 nichi 1 kai nano de, 1 kai atari no jougen wo agete okanai to kako bun ga owaranai.
$argument = '"{0}" --limit 50' -f $script
$action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
# PC ga suimin/denngen off datta bawai wa, tsugi ni okita toki ni oikake de jikkou suru.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName 'OrgiastPlaudToTldv' -Action $action -Trigger $trigger -Settings $settings -Description 'Import new Plaud recordings into tl;dv (daily 03:00)' -Force | Out-Null

Write-Host 'OK: task OrgiastPlaudToTldv registered (daily at 03:00)'
Get-ScheduledTask -TaskName 'OrgiastPlaudToTldv' | Select-Object TaskName, State
