# ASCII only. Run this script on each existing PC as well as during new setup.
# No existing installer/poller is changed by this standalone registration script.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\discord-autoreply.mjs')
$script = Join-Path $repo 'tools\discord-autoreply.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js 20 or newer first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'loop', '--seconds', '290', '--interval', '20') -WorkingDirectory $repo
# Omitting RepetitionDuration makes this Once trigger repeat indefinitely.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
# No AtLogOn trigger: registering one needs elevation on this PC (0x80070005), and the indefinite
# 5-minute repetition with StartWhenAvailable already resumes after a reboot.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OrgiastDiscordAutoReply' -Action $action -Trigger $repeat -Settings $settings -Principal $principal -Description 'Reply to mentions of kim and learn from corrections (every 5 minutes, polling every 20 seconds)' -Force | Out-Null
Start-ScheduledTask -TaskName 'OrgiastDiscordAutoReply'
Write-Host 'OK: OrgiastDiscordAutoReply registered and started.'
Get-ScheduledTask -TaskName 'OrgiastDiscordAutoReply' | Select-Object TaskName, State
