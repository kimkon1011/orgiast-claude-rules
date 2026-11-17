@echo off
rem ASCII only. Run once on 000: allows ONLY office LAN 192.168.0.0/24 to reach the Beeper gateway (TCP 23380, node.exe).
rem Public internet is not allowed. Tailscale Funnel is not used for this port.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$n=(Get-Command node).Source; Get-NetFirewallRule -DisplayName 'Orgiast Beeper Gateway (LAN only)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -DisplayName 'Orgiast Beeper Gateway (LAN only)' -Direction Inbound -Protocol TCP -LocalPort 23380 -RemoteAddress 192.168.0.0/24 -Program $n -Action Allow -Profile Any | Out-Null; Write-Host 'OK: firewall rule added (TCP 23380, 192.168.0.0/24 only).'"
pause
