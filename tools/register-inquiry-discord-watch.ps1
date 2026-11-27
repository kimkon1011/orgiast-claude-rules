# ASCII only. Register the inquiry Discord second-path watcher every 30 minutes.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\inquiry-discord-watch.mjs')
$script = Join-Path $repo 'tools\inquiry-discord-watch.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js 20 or newer first.' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
# Omitting RepetitionDuration makes this Once trigger repeat indefinitely.
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$settings.Priority = 4
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OrgiastInquiryDiscordWatch' -Action $action -Trigger $repeat -Settings $settings -Principal $principal -Description 'Send inquiry form notifications to Discord every 30 minutes' -Force | Out-Null
Start-ScheduledTask -TaskName 'OrgiastInquiryDiscordWatch'
Write-Host 'OK: OrgiastInquiryDiscordWatch registered and started.'
Get-ScheduledTask -TaskName 'OrgiastInquiryDiscordWatch' | Select-Object TaskName, State
