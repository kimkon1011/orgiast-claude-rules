# Booth seisaku app no "fuguai/youbou" sheet wo mainichi 03:00 ni tori-komi,
# ~/.claude/next-session.md no zan-TODO ni tsumu task wo touroku suru.
# Jikkou: powershell -ExecutionPolicy Bypass -File "<kono file>"
# Nando jikkou shitemo onaji task wo uwagaki suru dake (-Force). Hoka no task ni wa furenai.
#
# NOTE: kono file wa ASCII nomi de kaku koto (PS 5.1 ga BOM nashi UTF-8 no nihongo wo
# Shift-JIS to gokai shite parse error ni naru tame).

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $repo 'tools\booth-feedback-intake.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

# Console window taisaku: node wo chokusetsu jikkou suru to kuroi window ga deru node,
# console wo motanai wscript.exe kara run-hidden.vbs keiyu de kidou suru.
# stdout/stderr wa %USERPROFILE%\.claude\logs\booth-feedback-intake.log ni nokoru.
$hiddenRunner = Join-Path $repo 'tools\run-hidden.vbs'
if (-not (Test-Path $hiddenRunner)) { throw "hidden runner not found: $hiddenRunner" }

$argument = '//nologo "{0}" "{1}" "{2}"' -f $hiddenRunner, $node, $script
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument $argument -WorkingDirectory $repo

# 03:00 = yakan no OrgiastAutoSession (03:20) yori mae ni suru. Sono ban no muzin
# session ga sono hi no youbou wo hiroeru you ni suru tame.
$trigger = New-ScheduledTaskTrigger -Daily -At 3:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName 'OrgiastBoothFeedbackIntake' -Action $action -Trigger $trigger -Settings $settings -Description 'Pull booth app feedback rows into next-session.md TODO (daily 03:00)' -Force | Out-Null

Write-Host 'OK: task OrgiastBoothFeedbackIntake registered (daily 03:00)'
Get-ScheduledTask -TaskName 'OrgiastBoothFeedbackIntake' | Select-Object TaskName, State
