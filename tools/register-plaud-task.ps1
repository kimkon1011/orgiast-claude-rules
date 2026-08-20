# Plaud -> tl;dv jidou import wo 1 jikan goto ni jikkou suru task wo touroku suru.
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

# --limit 50: kako bun no toriKomi ga nokotte iru aida mo 1 kai de susumeru tame.
$argument = '"{0}" --limit 50' -f $script
$action = New-ScheduledTaskAction -Execute $node -Argument $argument -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
# PC ga suimin/dengen off datta bawai wa tsugi ni okita toki ni oikake de jikkou suru.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName 'OrgiastPlaudToTldv' -Action $action -Trigger $trigger -Settings $settings -Description 'Import new Plaud recordings into tl;dv (hourly)' -Force | Out-Null

Write-Host 'OK: task OrgiastPlaudToTldv registered (every hour)'
Get-ScheduledTask -TaskName 'OrgiastPlaudToTldv' | Select-Object TaskName, State
