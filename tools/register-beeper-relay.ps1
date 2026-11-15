# ASCII only. Run this script on kim-PC to register the Beeper Relay server as a Windows Scheduled Task.
# The server starts at logon and restarts if it crashes.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\beeper-relay-server.mjs')
$script = Join-Path $repo 'tools\beeper-relay-server.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js 22.13 or newer first.' }
$bindIP = $env:BEEPER_RELAY_BIND
if (-not $bindIP) {
  # Detect Tailscale IP from ipconfig
  $ipconfig = ipconfig
  $pattern = '\s+IPv4\s.*?(100\.\d+\.\d+\.\d+)'
  $m = ($ipconfig | Select-String -Pattern $pattern -Raw)
  if ($m) { $bindIP = $m.Trim() }
}
if (-not $bindIP) { $bindIP = '127.0.0.1' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--bind', $bindIP) -WorkingDirectory $repo
# Start at logon, restart every 5 minutes if crashed
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 365) -MultipleInstances IgnoreNew
$settings.Priority = 4
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OrgiastBeeperRelay' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Beeper Relay server for remote PC access (Tailscale-only, send via reply-queue)' -Force | Out-Null
Write-Host "OK: OrgiastBeeperRelay registered. Binds to $bindIP."
Get-ScheduledTask -TaskName 'OrgiastBeeperRelay' | Select-Object TaskName, State