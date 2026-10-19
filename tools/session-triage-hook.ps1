# session-triage-hook.ps1 - compatibility wrapper.
# The implementation is tools/session-triage-hook.mjs (shared by Windows and Linux).
$ErrorActionPreference = 'SilentlyContinue'
$mjs = Join-Path $PSScriptRoot 'session-triage-hook.mjs'
& node $mjs
exit $LASTEXITCODE
