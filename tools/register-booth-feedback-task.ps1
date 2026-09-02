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

# RepetitionDuration ni [TimeSpan]::MaxValue wo watasu to Duration=P99999999DT23H59M59S ni nari,
# Task Scheduler no XML ga "han-i-gai no atai" de reject suru (2026-09-02 jissoku de touroku shippai).
# Kadou-chuu no OrgiastFeedbackIntakeFast to onaji P3650D wo tsukau.
$trigger = New-ScheduledTaskTrigger -Once -At 12:05am -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$taskName = 'OrgiastBoothFeedbackIntake'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Poll booth app feedback into next-session.md every 10 minutes' -ErrorAction Stop | Out-Null

# Unregister shita ato de Register ga kokke suru to "task ga sonzai shinai" jotai ni naru.
# Register-ScheduledTask no error wa hi-shuuryou-kei no koto ga aru node, sonzai wo mite kara OK wo dasu.
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $registered) { throw "register failed: task '$taskName' does not exist after Register-ScheduledTask" }

Write-Host 'OK: task OrgiastBoothFeedbackIntake registered (every 10 minutes from 00:05)'
$registered | Select-Object TaskName, State
