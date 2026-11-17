# ASCII only. Run on 000 (the only PC that keeps Beeper Desktop).
# Creates the gateway token (value is never printed) and registers hidden tasks:
#  - If the admin firewall rule 'Orgiast Beeper Gateway (LAN only)' exists: node gateway listens on 0.0.0.0:23380 directly.
#  - Otherwise (no admin needed): node gateway on 127.0.0.1:23381 + python forwarder on 0.0.0.0:23380.
#    python.exe already has an inbound allow rule on 000; the forwarder only accepts office LAN / Tailscale IPs.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\beeper-gateway.mjs', 'tools\beeper-gateway-forward.py')
$script = Join-Path $repo 'tools\beeper-gateway.mjs'
$forward = Join-Path $repo 'tools\beeper-gateway-forward.py'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js 22.13 or newer first.' }
& $node $script init-token | Out-Host
$tokenFile = Join-Path $env:USERPROFILE '.claude\secrets\beeper-gateway-token.txt'
icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null

# stop old instances (tasks and listeners on 23380/23381)
foreach ($t in 'OrgiastBeeperGateway', 'OrgiastBeeperGatewayForward') { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 23380, 23381 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

$direct = [bool](Get-NetFirewallRule -DisplayName 'Orgiast Beeper Gateway (LAN only)' -ErrorAction SilentlyContinue)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$settings.Priority = 4
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)

if ($direct) {
  $args = @($script, 'serve')
  Unregister-ScheduledTask -TaskName 'OrgiastBeeperGatewayForward' -Confirm:$false -ErrorAction SilentlyContinue
} else {
  $args = @($script, 'serve', '--host', '127.0.0.1', '--port', '23381')
  $py = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -match 'python\.exe$' -and (Test-Path $_.Program) } |
    Where-Object { ($_ | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' -and $_.Direction -eq 'Inbound' -and "$($_.Profile)" -match 'Public|Any' }) } |
    Select-Object -First 1 -ExpandProperty Program
  if (-not $py) { throw 'No python.exe with an inbound firewall allow rule. Run tools\beeper-gateway-firewall.cmd once (admin Yes) and re-run.' }
  $fwd = New-HiddenScheduledTaskAction -Execute $py -ChildArgument @($forward, '23380', '23381') -WorkingDirectory $repo
  Register-ScheduledTask -TaskName 'OrgiastBeeperGatewayForward' -Action $fwd -Trigger $repeat -Settings $settings -Principal $principal -Description 'LAN front (python, IP allowlist) for the Beeper gateway on 127.0.0.1:23381' -Force | Out-Null
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument $args -WorkingDirectory $repo
Register-ScheduledTask -TaskName 'OrgiastBeeperGateway' -Action $action -Trigger $repeat -Settings $settings -Principal $principal -Description 'Serve 000 Beeper Desktop API to office LAN / Tailscale PCs (read + gated text send)' -Force | Out-Null
Start-ScheduledTask -TaskName 'OrgiastBeeperGateway'
if (-not $direct) { Start-ScheduledTask -TaskName 'OrgiastBeeperGatewayForward' }
Write-Host ("OK: Beeper gateway registered. mode=" + $(if ($direct) { 'direct (firewall rule)' } else { 'python forwarder (no admin)' }))
