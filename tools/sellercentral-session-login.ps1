# Seller Central: sign in manually, then close all browser windows with X.
$ErrorActionPreference = 'Stop'
$sessionExitCode = 4
try {
    & node (Join-Path $PSScriptRoot 'sellercentral-session.mjs') login
    $sessionExitCode = $LASTEXITCODE
} catch {
    Write-Host 'ERROR: Node.js or the login launcher could not start.'
}
Read-Host 'Press Enter to close'
exit $sessionExitCode
