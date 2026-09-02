# Booth seisaku app no "fuguai/youbou" sheet wo mainichi 03:06 ni tori-komi,
# ~/.claude/next-session.md no zan-TODO ni tsumu task wo touroku suru.
# Jikkou: powershell -ExecutionPolicy Bypass -File "<kono file>"
# Nando jikkou shitemo onaji task wo uwagaki suru dake (-Force). Hoka no task ni wa furenai.
#
# NOTE: kono file wa ASCII nomi de kaku koto (PS 5.1 ga BOM nashi UTF-8 no nihongo wo
# Shift-JIS to gokai shite parse error ni naru tame).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $repo 'tools\booth-feedback-intake.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

# Console window taisaku: node wo chokusetsu jikkou suru to kuroi window ga deru node,
# console wo motanai wscript.exe kara run-hidden.vbs keiyu de kidou suru.
# stdout/stderr wa %USERPROFILE%\.claude\logs\booth-feedback-intake.log ni nokoru.
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo

# 03:06 = yakan no OrgiastAutoSession (03:20) yori mae ni suru. Sono ban no muzin
# session ga sono hi no youbou wo hiroeru you ni suru tame.
$trigger = New-ScheduledTaskTrigger -Daily -At 3:06am -RandomDelay (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName 'OrgiastBoothFeedbackIntake' -Action $action -Trigger $trigger -Settings $settings -Description 'Pull booth app feedback rows into next-session.md TODO (daily 03:06, random delay up to 2 minutes)' -Force | Out-Null

Write-Host 'OK: task OrgiastBoothFeedbackIntake registered (daily 03:06, random delay up to 2 minutes)'
Get-ScheduledTask -TaskName 'OrgiastBoothFeedbackIntake' | Select-Object TaskName, State
