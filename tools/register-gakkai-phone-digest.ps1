# Register the daily gakkai phone location digest at 09:07 JST.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\gakkai-phone-digest.mjs')
$script = Join-Path $repo 'tools\gakkai-phone-digest.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 09:07
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'OrgiastGakkaiPhoneDigest' -Action $action -Trigger $trigger -Settings $settings -Description 'Daily 09:07 JST: Digest of gakkai phone location signals from Discord, posted to the gakkai phone channel' -Force | Out-Null
Write-Host ("OK: task OrgiastGakkaiPhoneDigest registered (daily 09:07)")
Get-ScheduledTask -TaskName 'OrgiastGakkaiPhoneDigest' | Select-Object TaskName, State