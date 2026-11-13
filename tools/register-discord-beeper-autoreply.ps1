# ASCII only. Run this script on each existing PC as well as during new setup.
# No existing installer/poller is changed by this standalone registration script.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\discord-beeper-autoreply.mjs')
$script = Join-Path $repo 'tools\discord-beeper-autoreply.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js 22.13 or newer first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'once') -WorkingDirectory $repo
# Omitting RepetitionDuration makes this Once trigger repeat indefinitely.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
# No AtLogOn trigger: registering one needs elevation on this PC (0x80070005), and the indefinite
# 5-minute repetition with StartWhenAvailable already resumes after a reboot.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
# Priority 7/BelowNormal starved Discord HTTP and abort timers on kim-PC.
# Priority 4 is NORMAL_PRIORITY_CLASS; keep background polling responsive.
$settings.Priority = 4
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OrgiastDiscordBeeperAutoReply' -Action $action -Trigger $repeat -Settings $settings -Principal $principal -Description 'Reply to kim Discord DMs and groups via Beeper (every 5 minutes)' -Force | Out-Null
Write-Host 'OK: OrgiastDiscordBeeperAutoReply registered. No immediate run.'
Get-ScheduledTask -TaskName 'OrgiastDiscordBeeperAutoReply' | Select-Object TaskName, State
