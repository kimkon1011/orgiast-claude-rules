# Booth seisaku app no "fuguai/youbou" sheet wo 10 pun goto ni tori-komi,
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

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$bootstrap = Join-Path $env:USERPROFILE '.claude\tools\nightly-bootstrap.ps1'
if (-not (Test-Path $bootstrap)) { throw "nightly bootstrap not found: $bootstrap" }

# Console window taisaku: node wo chokusetsu jikkou suru to kuroi window ga deru node,
# console wo motanai wscript.exe kara run-hidden.vbs keiyu de kidou suru.
# stdout/stderr wa %USERPROFILE%\.claude\logs\booth-feedback-intake.log ni nokoru.
$action = New-HiddenScheduledTaskAction -Execute $powershell -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', 'tools\booth-feedback-intake.mjs') -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Once -At 12:05am -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$taskName = 'OrgiastBoothFeedbackIntake'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Poll booth app feedback into next-session.md every 10 minutes' | Out-Null

Write-Host 'OK: task OrgiastBoothFeedbackIntake registered (every 10 minutes from 00:05)'
Get-ScheduledTask -TaskName 'OrgiastBoothFeedbackIntake' | Select-Object TaskName, State
