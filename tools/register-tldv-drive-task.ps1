# tl;dv -> Drive jidou hozon wo 1 jikan goto ni jikkou suru task wo touroku suru.
# Jikkou: powershell -ExecutionPolicy Bypass -File "<kono file>"
# Nando jikkou shitemo onaji task wo uwagaki suru dake (-Force). Hoka no task ni wa furenai.
#
# NOTE: kono file wa BOM tsuki UTF-8 de hozon suru koto. Windows PowerShell 5.1 wa
# BOM nashi UTF-8 wo Shift-JIS to gokai shi, nihongo ga aru to parse error ni naru.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\tldv-drive-backfill.mjs')
$script = Join-Path $repo 'tools\tldv-drive-backfill.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

# Console window taisaku: node wo chokusetsu jikkou suru to LogonType=Interactive no
# task ga 1 jikan goto ni kuroi window wo hyouji suru. Principal wo S4U ni kaeru houhou wa
# kanri sha kengen ga hitsuyou (Set-ScheduledTask ga Access Denied) datta node, console wo
# motanai wscript.exe kara run-hidden.vbs keiyu de kidou suru. stdout/stderr wa
# %USERPROFILE%\.claude\logs\tldv-drive-backfill.log ni nokoru.
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--all') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(20)) -RepetitionInterval (New-TimeSpan -Hours 1) -RandomDelay (New-TimeSpan -Minutes 2)
# PC ga suimin/dengen off datta bawai wa tsugi ni okita toki ni oikake de jikkou suru.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName 'OrgiastTldvDriveSync' -Action $action -Trigger $trigger -Settings $settings -Description 'Save new tl;dv meetings into Google Drive (hourly at :20, random delay up to 2 minutes)' -Force | Out-Null

Write-Host 'OK: task OrgiastTldvDriveSync registered (hourly at :20, random delay up to 2 minutes)'
Get-ScheduledTask -TaskName 'OrgiastTldvDriveSync' | Select-Object TaskName, State
