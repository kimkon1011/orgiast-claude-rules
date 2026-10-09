# Installed by nightly-bootstrap; use its updated checkout even when orgiast-main is dirty.
$ErrorActionPreference = 'Stop'
$repo = if ($env:ORGIAST_NIGHTLY_REPO) { $env:ORGIAST_NIGHTLY_REPO } else { Join-Path $HOME '.claude\nightly-repo' }
$helper = Join-Path $repo 'tools\sync-orgiast-main.mjs'
try {
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'sync helper missing; tree preserved' }
    & node $helper
    if ($LASTEXITCODE -ne 0) { throw "sync helper exit=$LASTEXITCODE" }
} catch {
    $logDir = Join-Path $HOME '.claude\logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $logDir 'sync-orgiast-main.log') -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' SYNC_FAILED ' + $_.Exception.Message) -Encoding UTF8
    exit 1
}
