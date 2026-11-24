# ASCII only. Run on a PC that should use 000's Beeper through the LAN gateway.
# -TokenFile: a file that holds the gateway token (copied from 000 without printing it). It is deleted after import.
# Writes %USERPROFILE%\.claude\secrets\beeper-gateway.json (user-only ACL). Never prints the token.
param(
  [Parameter(Mandatory = $true)][string]$TokenFile,
  [string]$Base = 'http://000KimPC:23380'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $TokenFile)) { throw "token file not found: $TokenFile" }
$token = (Get-Content -Raw -Path $TokenFile).Trim()
if ($token.Length -lt 20) { throw 'token file looks empty' }
$dir = Join-Path $env:USERPROFILE '.claude\secrets'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$out = Join-Path $dir 'beeper-gateway.json'
$json = @{ base = $Base; hosts = @('http://000KimPC:23380', 'http://000KIMPC.local:23380'); token = $token } | ConvertTo-Json -Compress
[IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding($false)))
$token = $null; $json = $null
icacls $out /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
Remove-Item -Force $TokenFile
Write-Host "OK: gateway config written (token not shown): $out -> $Base"
