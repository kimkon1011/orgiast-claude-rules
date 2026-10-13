# Installed by nightly-bootstrap; use its updated checkout even when orgiast-main is dirty.
$ErrorActionPreference = 'Stop'
$repo = if ($env:ORGIAST_NIGHTLY_REPO) { $env:ORGIAST_NIGHTLY_REPO } else { Join-Path $HOME '.claude\nightly-repo' }
$helper = Join-Path $repo 'tools\sync-orgiast-main.mjs'
try {
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'sync helper missing; tree preserved' }
    & node $helper
    if ($LASTEXITCODE -ne 0) { throw "sync helper exit=$LASTEXITCODE" }
} catch {
    # run-hidden.vbs holds sync-orgiast-main.log open via `cmd /c ... >>`, so Add-Content
    # there throws EBUSY. Emit to stdout (which the vbs redirect captures) and only fall
    # back to a sibling events log; a logging failure must not mask the real error.
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' SYNC_FAILED ' + $_.Exception.Message
    Write-Output $line
    $logDir = Join-Path $HOME '.claude\logs'
    try {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        Add-Content -LiteralPath (Join-Path $logDir 'sync-orgiast-main.log') -Value $line -Encoding UTF8
    } catch {
        try {
            Add-Content -LiteralPath (Join-Path $logDir 'sync-orgiast-main.events.log') -Value $line -Encoding UTF8
        } catch { }
    }
    exit 1
}
