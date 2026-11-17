# ASCII only. Run on 000 (the PC whose Beeper Desktop serves the other PCs).
# Creates the gateway token (value is never printed) and registers a hidden task that keeps
# tools/beeper-gateway.mjs serve running (re-launch every 5 minutes; a running instance is kept).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\beeper-gateway.mjs')
$script = Join-Path $repo 'tools\beeper-gateway.mjs'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js 22.13 or newer first.' }
& $node $script init-token | Out-Host
$tokenFile = Join-Path $env:USERPROFILE '.claude\secrets\beeper-gateway-token.txt'
icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, 'serve') -WorkingDirectory $repo
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$settings.Priority = 4
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OrgiastBeeperGateway' -Action $action -Trigger $repeat -Settings $settings -Principal $principal -Description 'Serve this PC Beeper Desktop API to office LAN / Tailscale PCs (read + gated text send)' -Force | Out-Null
Start-ScheduledTask -TaskName 'OrgiastBeeperGateway'
Write-Host 'OK: OrgiastBeeperGateway registered and started.'
Write-Host 'Inbound firewall needs one admin approval: run tools\beeper-gateway-firewall.cmd once (double-click, then Yes).'
