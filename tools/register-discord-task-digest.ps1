# Register the daily task ledger refresh at 06:30 JST (mail first, then Discord).
# Mail carries the decisions and Discord carries the declarations, so both sources
# must land in the same ledger or the report is wrong in both directions.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$discord = Join-Path $repo 'tools\discord-task-digest.mjs'
if (-not (Test-Path $discord)) { throw "script not found: $discord" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$actions = @()
# The mail pass runs first so the Discord pass can suppress items mail already closed.
$mail = Join-Path $repo 'tools\mail-task-digest.mjs'
if (Test-Path $mail) {
  $actions += New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($mail, '--since', '2', '--max', '60') -WorkingDirectory $repo
} else {
  Write-Warning 'mail-task-digest.mjs not found; registering the Discord pass only.'
}
$actions += New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($discord, '--since', '24h', '--max-channels', '120') -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Daily -At 6:30am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 60)
Register-ScheduledTask -TaskName 'OrgiastDiscordTaskDigest' -Action $actions -Trigger $trigger -Settings $settings -Description 'Refresh the prioritized task ledger from seisaku-team mail and all Discord channels (daily 06:30)' -Force | Out-Null
Write-Host ("OK: task OrgiastDiscordTaskDigest registered (daily 06:30, " + $actions.Count + " action(s))")
Get-ScheduledTask -TaskName 'OrgiastDiscordTaskDigest' | Select-Object TaskName, State
